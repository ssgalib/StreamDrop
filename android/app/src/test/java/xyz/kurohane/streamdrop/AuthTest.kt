package xyz.kurohane.streamdrop

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
private fun unhex(s: String) = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

class AuthTest {
    private val v = JSONObject(File("../../docs/vectors.json").readText())
    private val inputs = v.getJSONObject("inputs")
    private val f = Fingerprints(unhex(inputs.getString("fo")), unhex(inputs.getString("fa")))
    private val no = unb64u(inputs.getString("no"), 32)!!
    private val na = unb64u(inputs.getString("na"), 32)!!

    @Test fun base32() {
        assertEquals("MZXW6YTBOI", b32("foobar".toByteArray()))
        val bytes = randomBytes(16)
        assertEquals(26, b32(bytes).length)
        assertArrayEquals(bytes, b32decode(b32(bytes)))
    }

    @Test fun pairVectors() {
        val key = pairProofKey(inputs.getString("p"))
        assertEquals(v.getString("pairProofKey"), hex(key))
        val t = transcript("pair", f, no, na)
        val pair = v.getJSONObject("pair")
        assertEquals(pair.getString("transcript"), hex(t))
        assertEquals(pair.getString("offerProof"), b64u(hmac(key, proofInput("offer", t))))
        assertEquals(pair.getString("answerProof"), b64u(hmac(key, proofInput("answer", t))))
    }

    @Test fun savedVectors() {
        val k = deriveK(inputs.getString("p"), unb64u(inputs.getString("ro"), 32)!!, unb64u(inputs.getString("ra"), 32)!!, f)
        assertEquals(v.getString("k"), hex(k))
        val keys = savedKeys(k)
        assertEquals(v.getString("roomId"), keys.roomId)
        assertEquals(v.getString("ka"), hex(keys.ka))
        val t = transcript("saved", f, no, na)
        val saved = v.getJSONObject("saved")
        assertEquals(saved.getString("offerProof"), b64u(hmac(keys.ka, proofInput("offer", t))))
        assertEquals(saved.getString("answerProof"), b64u(hmac(keys.ka, proofInput("answer", t))))
        val confirm = v.getJSONObject("confirm")
        assertEquals(confirm.getString("offer"), b64u(hmac(keys.ka, confirmInput("offer"))))
        assertEquals(confirm.getString("answer"), b64u(hmac(keys.ka, confirmInput("answer"))))
    }

    @Test fun fingerprints() {
        val fp = (0 until 32).joinToString(":") { "%02X".format(it) }
        assertArrayEquals(ByteArray(32) { it.toByte() }, sdpFingerprint("v=0\r\na=fingerprint:sha-256 $fp\r\na=x\r\n"))
        assertNull(sdpFingerprint("a=fingerprint:sha-256 $fp\r\na=fingerprint:sha-256 ${fp.replace("00", "FF")}\r\n"))
        assertNull(sdpFingerprint("a=fingerprint:sha-1 AA:BB\r\n"))
        assertNull(sdpFingerprint("v=0\r\n"))
        assertNull(sdpFingerprint(null))
    }

    @Test fun invites() {
        val t = "A".repeat(26)
        val p = "B".repeat(26)
        assertEquals(p, parseInvite(" https://x/#$t.$p\n").p)
        assertEquals(t, parseInvite("$t.$p").token)
        assertNull(parseInvite("$t.short").p)
        assertNull(parseInvite(t).p)
    }

    @Test fun messagesStartWithT() {
        assertEquals("""{"t":"hello","v":2,"caps":["pair"]}""", msg("hello", "v" to 2, "caps" to listOf("pair")))
        assertTrue(msg("x", "a" to "q\"uote").startsWith("{\"t\":\"x\""))
    }

    private class End {
        var verified: Boolean? = null
        var failed: String? = null
        val delivered = ArrayList<Data>()
    }

    private fun link(keyA: ByteArray?, keyB: ByteArray?, requiredB: Boolean = false, fpB: Fingerprints = f): Pair<End, End> {
        val a = End()
        val b = End()
        val toA = ArrayDeque<String>()
        val toB = ArrayDeque<String>()
        val ga = Gate("offer", "pair", keyA, false, emptyList(), { f }, { toB.add(it) }, { a.delivered.add(it) }, { ok, _ -> a.verified = ok }, { a.failed = it })
        val gb = Gate("answer", "pair", keyB, requiredB, emptyList(), { fpB }, { toA.add(it) }, { b.delivered.add(it) }, { ok, _ -> b.verified = ok }, { b.failed = it })
        ga.start()
        gb.start()
        while (toA.isNotEmpty() || toB.isNotEmpty()) {
            toA.removeFirstOrNull()?.let { ga.message(Data.Text(it)) }
            toB.removeFirstOrNull()?.let { gb.message(Data.Text(it)) }
        }
        return a to b
    }

    private val key = pairProofKey(newId())

    @Test fun sameKeyVerifies() {
        val (a, b) = link(key, key, requiredB = true)
        assertEquals(true, a.verified)
        assertEquals(true, b.verified)
    }

    @Test fun wrongKeyFails() {
        val (a, b) = link(key, pairProofKey(newId()), requiredB = true)
        assertEquals("auth", a.failed)
        assertEquals("auth", b.failed)
    }

    @Test fun someoneInTheMiddleFails() {
        val (a, b) = link(key, key, requiredB = true, fpB = Fingerprints(ByteArray(32) { 9 }, f.fa))
        assertEquals("auth", a.failed)
        assertEquals("auth", b.failed)
    }

    @Test fun noKeyIsTemporary() {
        val (a, b) = link(key, null)
        assertEquals(false, a.verified)
        assertEquals(false, b.verified)
    }

    @Test fun aRequiredProofCantBeDropped() {
        val (_, b) = link(null, key, requiredB = true)
        assertEquals("auth", b.failed)
    }
}
