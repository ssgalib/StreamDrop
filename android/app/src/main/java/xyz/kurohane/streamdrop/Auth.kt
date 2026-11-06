package xyz.kurohane.streamdrop

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.json.JSONArray
import org.json.JSONObject

// A port of web/src/auth.ts and the key derivation in web/src/saved.ts. docs/protocol.md is the spec;
// docs/vectors.json checks this file. No Android classes here, so it runs in plain JVM tests.

const val VERSION = 2
const val MIN_VERSION = 1
private const val MAX_HELD = 256
private const val B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
private val ID_RE = Regex("^[A-Z2-7]{26}$")

fun isId(s: String?) = s != null && ID_RE.matches(s)

fun b32(bytes: ByteArray): String {
    val out = StringBuilder()
    var bits = 0
    var value = 0
    for (b in bytes) {
        value = ((value shl 8) or (b.toInt() and 255)) and 0xfff
        bits += 8
        while (bits >= 5) {
            out.append(B32[(value ushr (bits - 5)) and 31])
            bits -= 5
        }
    }
    if (bits > 0) out.append(B32[(value shl (5 - bits)) and 31])
    return out.toString()
}

fun b32decode(s: String): ByteArray {
    val out = ArrayList<Byte>()
    var bits = 0
    var value = 0
    for (c in s) {
        value = ((value shl 5) or B32.indexOf(c)) and 0xfff
        bits += 5
        if (bits >= 8) {
            bits -= 8
            out.add(((value ushr bits) and 255).toByte())
        }
    }
    return out.toByteArray()
}

fun b64u(b: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(b)

fun unb64u(s: Any?, length: Int): ByteArray? {
    if (s !is String) return null
    return try {
        Base64.getUrlDecoder().decode(s).takeIf { it.size == length }
    } catch (_: IllegalArgumentException) {
        null
    }
}

fun randomBytes(n: Int) = ByteArray(n).also { SecureRandom().nextBytes(it) }
fun newId() = b32(randomBytes(16))

fun hmac(key: ByteArray, data: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(key, "HmacSHA256"))
    return mac.doFinal(data)
}

fun hkdf(ikm: ByteArray, info: String, salt: ByteArray = ByteArray(0)): ByteArray {
    val prk = hmac(if (salt.isEmpty()) ByteArray(32) else salt, ikm)
    return hmac(prk, info.toByteArray() + 1)
}

fun pairProofKey(p: String) = hkdf(b32decode(p), "sd-pair-proof")

class Fingerprints(val fo: ByteArray, val fa: ByteArray)

fun transcript(mode: String, f: Fingerprints, no: ByteArray, na: ByteArray) =
    "streamdrop-v2\u0000$mode\u0000".toByteArray() + f.fo + f.fa + no + na

fun proofInput(role: String, t: ByteArray) = role.toByteArray() + t

fun deriveK(p: String, ro: ByteArray, ra: ByteArray, f: Fingerprints) =
    hkdf(b32decode(p) + ro + ra, "sd-pair-key", f.fo + f.fa)

class SavedKeys(val roomId: String, val ka: ByteArray)

fun savedKeys(k: ByteArray) = SavedKeys(b32(hkdf(k, "sd-room").copyOf(16)), hkdf(k, "sd-auth"))

fun confirmInput(role: String) = "confirm$role".toByteArray()

private val FINGERPRINT = Regex("^a=fingerprint:(\\S+) (\\S+)\\s*$", setOf(RegexOption.MULTILINE, RegexOption.IGNORE_CASE))
private val SHA256 = Regex("^([0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}$")

// The one sha-256 fingerprint of an SDP. Anything else is refused: the proof must cover exactly what the connection checks.
fun sdpFingerprint(sdp: String?): ByteArray? {
    val found = HashSet<String>()
    for (m in FINGERPRINT.findAll((sdp ?: "").replace("\r", ""))) {
        val (algo, value) = m.destructured
        if (!algo.equals("sha-256", ignoreCase = true) || !SHA256.matches(value)) return null
        found.add(value.uppercase())
    }
    val one = found.singleOrNull() ?: return null
    return one.split(":").map { it.toInt(16).toByte() }.toByteArray()
}

class Invite(val token: String, val p: String?)

// P must never reach the server, so everything that came with the token is split off here, whatever was pasted.
fun parseInvite(text: String): Invite {
    val parts = text.trim().substringAfterLast('#').split(".")
    return Invite(parts[0], parts.getOrNull(1)?.takeIf(::isId))
}

// Control messages MUST start with "t": old pages recognise them by that, and JSONObject doesn't keep key order.
fun msg(t: String, vararg fields: Pair<String, Any?>): String {
    val out = StringBuilder("{\"t\":").append(JSONObject.quote(t))
    for ((k, v) in fields) {
        out.append(',').append(JSONObject.quote(k)).append(':')
        out.append(
            when (v) {
                is String -> JSONObject.quote(v)
                is List<*> -> JSONArray(v).toString()
                else -> v.toString()
            },
        )
    }
    return out.append('}').toString()
}

sealed interface Data {
    class Text(val text: String) : Data
    class Binary(val bytes: ByteArray) : Data
}

// Runs when a DataChannel opens. Nothing but hello, auth-* and bye gets through until it passes. Everything is
// called on one thread, so unlike the TypeScript it needs no queue. The caller runs noHello() and timedOut() from timers.
class Gate(
    private val role: String,
    private val mode: String,
    private val key: ByteArray?,
    private val required: Boolean,
    private val caps: List<String>,
    private val fingerprints: () -> Fingerprints?,
    private val send: (String) -> Unit,
    private val deliver: (Data) -> Unit,
    private val passed: (Boolean, List<String>) -> Unit,
    private val failed: (String) -> Unit,
) {
    private enum class State { HELLO, AUTH, OPEN, CLOSED }

    private var state = State.HELLO
    private var t: ByteArray? = null
    private var peerCaps = emptyList<String>()
    private val held = ArrayList<Data>()
    private val mine = randomBytes(32)
    private val other = if (role == "offer") "answer" else "offer"

    fun start() = send(msg("hello", "v" to VERSION, "min" to MIN_VERSION, "caps" to (if (key != null) listOf(mode) else emptyList()) + caps))

    fun timedOut() {
        if (state == State.HELLO) noHello() else if (state == State.AUTH) fail("auth")
    }

    fun close() {
        state = State.CLOSED
        held.clear()
    }

    private fun fail(reason: String) {
        if (state == State.CLOSED) return
        state = State.CLOSED
        held.clear()
        runCatching { send(if (reason == "upgrade") msg("bye", "reason" to reason, "min" to MIN_VERSION) else msg("bye", "reason" to reason)) }
        failed(reason)
    }

    private fun pass(verified: Boolean) {
        val waiting = held.toList()
        held.clear()
        state = State.OPEN
        passed(verified, peerCaps)
        waiting.forEach(deliver)
    }

    // A version 1 peer never says hello.
    private fun noHello() = if (required) fail("auth") else pass(false)

    fun message(data: Data) {
        if (state == State.CLOSED) return
        if (state == State.OPEN) return deliver(data)
        val m = (data as? Data.Text)?.let { runCatching { JSONObject(it.text) }.getOrNull() }
        when (m?.optString("t")) {
            "hello" -> return if (state == State.HELLO) onHello(m) else fail("auth")
            "auth-n" -> return onNonce(m)
            "auth-p" -> return onProof(m)
            "bye" -> return deliver(data) // an unproven goodbye can only end the attempt
        }
        if (state == State.HELLO) {
            noHello() // ordered channel: anything before a hello means none is coming
            return message(data)
        }
        if (held.size >= MAX_HELD) return fail("auth")
        held.add(data)
    }

    private fun onHello(m: JSONObject) {
        val v = m.opt("v") as? Int
        val min = m.opt("min") as? Int
        val theirCaps = m.opt("caps") as? JSONArray
        if (v == null || min == null || theirCaps == null) return fail("auth")
        if (v < MIN_VERSION || min > VERSION) return fail("upgrade")
        peerCaps = (0 until theirCaps.length()).mapNotNull { theirCaps.opt(it) as? String }
        if (key != null && mode in peerCaps) {
            state = State.AUTH
            return send(msg("auth-n", "mode" to mode, "n" to b64u(mine)))
        }
        if (required) return fail("auth")
        pass(false)
    }

    private fun onNonce(m: JSONObject) {
        val theirs = unb64u(m.opt("n"), 32)
        val f = fingerprints()
        if (state != State.AUTH || t != null || m.opt("mode") != mode || theirs == null || f == null) return fail("auth")
        val tr = if (role == "offer") transcript(mode, f, mine, theirs) else transcript(mode, f, theirs, mine)
        t = tr
        send(msg("auth-p", "p" to b64u(hmac(key!!, proofInput(role, tr)))))
    }

    private fun onProof(m: JSONObject) {
        val p = unb64u(m.opt("p"), 32)
        val tr = t
        // MessageDigest.isEqual is constant time
        if (state != State.AUTH || tr == null || p == null || !MessageDigest.isEqual(p, hmac(key!!, proofInput(other, tr)))) return fail("auth")
        pass(true)
    }
}
