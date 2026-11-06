package xyz.kurohane.streamdrop

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription

// shortcut: the M1 spike, driven by adb and logcat. It answers "does libwebrtc work here?" and has no UI, no resume and
// one file at a time. M3 replaces this file; Auth.kt stays.
//   adb shell am start-foreground-service -n xyz.kurohane.streamdrop/.SpikeService --es server ws://10.0.2.2:8080/ws --es invite 'TOKEN.P' [--es send name]
class SpikeService : Service() {
    private val tag = "SD"
    private val loop = Executors.newSingleThreadScheduledExecutor() // everything but the file loops runs here
    private val http = OkHttpClient.Builder().pingInterval(0, TimeUnit.SECONDS).build()
    private lateinit var factory: PeerConnectionFactory
    private lateinit var dir: File
    private var ws: WebSocket? = null
    private var pc: PeerConnection? = null
    private var dc: DataChannel? = null
    private var gate: Gate? = null
    private var offerer = false
    private var proofKey: ByteArray? = null
    private var required = false
    private var toSend: File? = null
    private var pendingCandidates = ArrayList<IceCandidate>()
    private var wake: PowerManager.WakeLock? = null

    private class Incoming(val id: String, val name: String, val size: Long, val out: RandomAccessFile) {
        var stored = 0L
        var lastAck = 0L
        val started = System.nanoTime()
    }

    private val incoming = HashMap<String, Incoming>()
    private val sendLock = Object()
    @Volatile private var acked = 0L
    @Volatile private var accepted = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("t", "Transfers", NotificationManager.IMPORTANCE_LOW))
        val n = Notification.Builder(this, "t").setContentTitle("StreamDrop").setSmallIcon(android.R.drawable.stat_sys_upload).build()
        startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        dir = getExternalFilesDir(null)!!
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(this).createInitializationOptions())
        factory = PeerConnectionFactory.builder().createPeerConnectionFactory()
        wake = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sd:transfer").apply { acquire(3 * 3600_000L) }
    }

    override fun onDestroy() {
        wake?.release()
        super.onDestroy()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val server = intent?.getStringExtra("server") ?: return START_NOT_STICKY
        toSend = intent.getStringExtra("send")?.let { File(dir, it) }
        val invite = intent.getStringExtra("invite")
        loop.execute { connect(server, invite) }
        return START_NOT_STICKY
    }

    private fun connect(server: String, inviteText: String?) {
        val first: String
        if (inviteText != null) {
            val invite = parseInvite(inviteText)
            proofKey = invite.p?.let(::pairProofKey)
            required = invite.p != null
            first = JSONObject().put("type", "join").put("token", invite.token).toString() // never P
        } else {
            val p = newId()
            proofKey = pairProofKey(p)
            inviteKey = p
            first = """{"type":"create"}"""
        }
        ws = http.newWebSocket(Request.Builder().url(server).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { webSocket.send(first) }
            override fun onMessage(webSocket: WebSocket, text: String) { loop.execute { onSignal(JSONObject(text)) } }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { Log.e(tag, "signaling failed: $t") }
        })
    }

    private var inviteKey: String? = null

    private fun onSignal(m: JSONObject) {
        when (m.getString("type")) {
            "created" -> Log.i(tag, "INVITE ${m.optString("token")}.$inviteKey")
            "joined" -> { offerer = false; makePeer(m.optJSONArray("iceServers")) }
            "peer-joined" -> { offerer = true; makePeer(m.optJSONArray("iceServers")); makeOffer() }
            "offer" -> setRemote(SessionDescription.Type.OFFER, m.getString("sdp")) { makeAnswer() }
            "answer" -> setRemote(SessionDescription.Type.ANSWER, m.getString("sdp")) {}
            "candidate" -> {
                val c = m.getJSONObject("candidate")
                val ice = IceCandidate(c.optString("sdpMid"), c.optInt("sdpMLineIndex"), c.getString("candidate"))
                Log.i(tag, "remote candidate ${ice.sdp.split(" ").let { "${it[2]} ${if (':' in it[4]) "v6" else "v4"} typ ${it[7]}" }}")
                if (pc?.remoteDescription != null) pc?.addIceCandidate(ice) else pendingCandidates.add(ice)
            }
            "error" -> Log.e(tag, "server error ${m.optString("code")}")
            "peer-left" -> Log.i(tag, "peer-left")
        }
    }

    private fun makePeer(relay: JSONArray?) {
        val servers = arrayListOf(PeerConnection.IceServer.builder("stun:stun.cloudflare.com:3478").createIceServer())
        Log.i(tag, "peer, offerer=$offerer, relay servers=${relay?.length() ?: 0}")
        val config = PeerConnection.RTCConfiguration(servers).apply { sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN }
        pc = factory.createPeerConnection(config, object : PeerConnection.Observer {
            override fun onIceCandidate(c: IceCandidate) {
                Log.i(tag, "local candidate ${c.sdp.split(" ").let { "${it[2]} ${if (':' in it[4]) "v6" else "v4"} typ ${it[7]}" }}")
                loop.execute {
                    val json = JSONObject().put("candidate", c.sdp).put("sdpMid", c.sdpMid).put("sdpMLineIndex", c.sdpMLineIndex)
                    ws?.send(JSONObject().put("type", "candidate").put("candidate", json).toString())
                }
            }
            override fun onConnectionChange(s: PeerConnection.PeerConnectionState) { Log.i(tag, "connection $s") }
            override fun onDataChannel(d: DataChannel) { loop.execute { useChannel(d) } }
            override fun onSignalingChange(s: PeerConnection.SignalingState) {}
            override fun onIceConnectionChange(s: PeerConnection.IceConnectionState) { Log.i(tag, "ice $s") }
            override fun onIceConnectionReceivingChange(b: Boolean) {}
            override fun onIceGatheringChange(s: PeerConnection.IceGatheringState) {}
            override fun onIceCandidatesRemoved(c: Array<out IceCandidate>) {}
            override fun onAddStream(s: MediaStream) {}
            override fun onRemoveStream(s: MediaStream) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(r: RtpReceiver, s: Array<out MediaStream>) {}
        })
        if (offerer) useChannel(pc!!.createDataChannel("file", DataChannel.Init().apply { ordered = true }))
    }

    private abstract class Sdp : SdpObserver {
        override fun onCreateSuccess(d: SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(e: String) { Log.e("SD", "sdp create: $e") }
        override fun onSetFailure(e: String) { Log.e("SD", "sdp set: $e") }
    }

    private fun setRemote(type: SessionDescription.Type, sdp: String, then: () -> Unit) {
        pc?.setRemoteDescription(object : Sdp() {
            override fun onSetSuccess() {
                loop.execute {
                    pendingCandidates.forEach { pc?.addIceCandidate(it) }
                    pendingCandidates.clear()
                    then()
                }
            }
        }, SessionDescription(type, sdp))
    }

    private fun makeOffer() = describe("offer") { c, s -> pc?.createOffer(s, c) }
    private fun makeAnswer() = describe("answer") { c, s -> pc?.createAnswer(s, c) }

    private fun describe(type: String, create: (MediaConstraints, SdpObserver) -> Unit) {
        create(MediaConstraints(), object : Sdp() {
            override fun onCreateSuccess(d: SessionDescription) {
                pc?.setLocalDescription(object : Sdp() {
                    override fun onSetSuccess() {
                        ws?.send(JSONObject().put("type", type).put("sdp", d.description).toString())
                    }
                }, d)
            }
        })
    }

    private fun useChannel(d: DataChannel) {
        dc = d
        d.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previous: Long) { synchronized(sendLock) { sendLock.notifyAll() } }
            override fun onStateChange() {
                val s = d.state()
                Log.i(tag, "channel $s")
                if (s == DataChannel.State.OPEN) loop.execute(::startGate)
            }
            override fun onMessage(b: DataChannel.Buffer) {
                // The buffer is only valid during this call.
                val bytes = ByteArray(b.data.remaining()).also(b.data::get)
                val data = if (b.binary) Data.Binary(bytes) else Data.Text(String(bytes))
                // libwebrtc can deliver what it buffered as soon as the observer registers, before any OPEN event.
                loop.execute {
                    startGate()
                    gate?.message(data)
                }
            }
        })
        if (d.state() == DataChannel.State.OPEN) loop.execute(::startGate)
    }

    private fun sendText(s: String) {
        dc?.send(DataChannel.Buffer(ByteBuffer.wrap(s.toByteArray()), false))
    }

    private fun startGate() {
        if (gate != null) return
        val g = Gate(
            role = if (offerer) "offer" else "answer",
            mode = "pair",
            key = proofKey,
            required = required,
            caps = listOf("save"),
            fingerprints = {
                val l = sdpFingerprint(pc?.localDescription?.description)
                val r = sdpFingerprint(pc?.remoteDescription?.description)
                if (l == null || r == null) null else if (offerer) Fingerprints(l, r) else Fingerprints(r, l)
            },
            send = ::sendText,
            deliver = ::onData,
            passed = { verified, caps ->
                Log.i(tag, "GATE passed verified=$verified caps=$caps")
                if (offerer) sendText(msg("session", "id" to newId()))
                toSend?.let { offer(it) }
            },
            failed = { Log.e(tag, "GATE failed $it") },
        )
        gate = g
        g.start()
        loop.schedule({ g.timedOut() }, if (required) 15 else 3, TimeUnit.SECONDS)
    }

    private fun onData(d: Data) {
        when (d) {
            is Data.Binary -> onFrame(d.bytes)
            is Data.Text -> onControl(runCatching { JSONObject(d.text) }.getOrNull() ?: return)
        }
    }

    private fun onFrame(b: ByteArray) {
        if (b.size < 26) return
        val it = incoming[String(b, 0, 26)] ?: return
        it.out.write(b, 26, b.size - 26)
        it.stored += b.size - 26
        if (it.stored / (256L shl 20) != (it.stored - (b.size - 26)) / (256L shl 20)) {
            val secs = (System.nanoTime() - it.started) / 1e9
            Log.i(tag, "progress ${it.stored shr 20} MiB at %.1f s, %.1f MiB/s overall".format(secs, it.stored / secs / 1048576))
        }
        if (it.stored - it.lastAck >= 1024 * 1024) {
            it.lastAck = it.stored
            sendText(msg("ack", "bytes" to it.stored, "id" to it.id))
        }
    }

    private var sendId = ""

    private fun onControl(m: JSONObject) {
        val id = m.optString("id")
        when (m.optString("t")) {
            "meta" -> {
                val name = File(m.getString("name")).name // shortcut: the spike's own folder only; M3 needs the checks in docs/protocol.md
                val size = m.getLong("size")
                val out = RandomAccessFile(File(dir, "recv-$name"), "rw").apply { setLength(0) }
                incoming[id] = Incoming(id, name, size, out)
                Log.i(tag, "OFFER $name $size")
                sendText(msg("accept", "id" to id))
            }
            "done" -> incoming.remove(id)?.let {
                it.out.fd.sync()
                it.out.close()
                sendText(msg("saved", "id" to id))
                val secs = (System.nanoTime() - it.started) / 1e9
                Log.i(tag, "RECEIVED ${it.name} ${it.stored} bytes in %.1f s, %.1f MiB/s, heap %d MiB".format(secs, it.stored / secs / 1048576, usedHeap()))
            }
            "accept" -> if (id == sendId) { accepted = true; synchronized(sendLock) { sendLock.notifyAll() } }
            "ack" -> if (id == sendId) { acked = m.getLong("bytes"); synchronized(sendLock) { sendLock.notifyAll() } }
            "saved" -> if (id == sendId) Log.i(tag, "SENT confirmed saved")
            "bye" -> Log.i(tag, "bye ${m.optString("reason")}")
        }
    }

    private fun usedHeap() = (Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory()) shr 20

    private fun fingerprintOf(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        md.update("${f.length()}:${f.lastModified()}:".toByteArray())
        RandomAccessFile(f, "r").use { r ->
            val mib = 1024 * 1024
            val head = ByteArray(minOf(f.length(), mib.toLong()).toInt())
            r.readFully(head)
            md.update(head)
            r.seek(maxOf(0, f.length() - mib))
            md.update(head.also { r.readFully(it) })
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    private fun offer(f: File) {
        sendId = newId()
        sendText(msg("meta", "id" to sendId, "name" to f.name, "size" to f.length(), "type" to "application/octet-stream", "fp" to fingerprintOf(f)))
        Log.i(tag, "OFFERED ${f.name}")
        Thread({ stream(f) }, "sender").start()
    }

    // Stops above 4 MiB buffered and continues below 1 MiB: libwebrtc refuses sends once its buffer fills.
    private fun stream(f: File) {
        synchronized(sendLock) { while (!accepted) sendLock.wait() }
        val id = sendId.toByteArray()
        val started = System.nanoTime()
        val buf = ByteBuffer.allocateDirect(26 + 64 * 1024) // reused, so memory stays flat at any size
        val chunk = ByteArray(64 * 1024)
        var sent = 0L
        f.inputStream().buffered(1024 * 1024).use { input ->
            while (true) {
                val n = input.read(chunk)
                if (n < 0) break
                synchronized(sendLock) {
                    while ((dc?.bufferedAmount() ?: 0) > 4 * 1024 * 1024 || sent - acked >= 16 * 1024 * 1024) sendLock.wait(100)
                }
                buf.clear()
                buf.put(id).put(chunk, 0, n).flip()
                if (dc?.send(DataChannel.Buffer(buf, true)) != true) { Log.e(tag, "send refused at $sent"); return }
                sent += n
            }
        }
        sendText(msg("done", "id" to sendId))
        val secs = (System.nanoTime() - started) / 1e9
        Log.i(tag, "SENT ${f.name} $sent bytes in %.1f s, %.1f MiB/s, heap %d MiB".format(secs, sent / secs / 1048576, usedHeap()))
    }
}
