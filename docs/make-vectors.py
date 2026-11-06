#!/usr/bin/env python3
"""Writes docs/vectors.json with the standard library only, so the vectors check each client's crypto
independently instead of repeating it. Inputs are fixed: running this again gives the same file."""
import base64, hashlib, hmac, json, os

def hkdf(ikm, info, salt=b""):
    prk = hmac.new(salt or bytes(32), ikm, hashlib.sha256).digest()
    return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()

mac = lambda key, data: hmac.new(key, data, hashlib.sha256).digest()
b32 = lambda b: base64.b32encode(b).decode().rstrip("=")
b64u = lambda b: base64.urlsafe_b64encode(b).decode().rstrip("=")
seq = lambda start, n: bytes((start + i) % 256 for i in range(n))

P = seq(0x10, 16)
FO, FA = seq(0x40, 32), seq(0x80, 32)
NO, NA = seq(0xA0, 32), seq(0xC0, 32)
RO, RA = seq(0x20, 32), seq(0x60, 32)

K = hkdf(P + RO + RA, b"sd-pair-key", FO + FA)
KA = hkdf(K, b"sd-auth")
pair_key = hkdf(P, b"sd-pair-proof")
transcript = lambda mode: b"streamdrop-v2\0" + mode + b"\0" + FO + FA + NO + NA

out = {
    "inputs": {
        "p": b32(P), "fo": FO.hex(), "fa": FA.hex(),
        "no": b64u(NO), "na": b64u(NA), "ro": b64u(RO), "ra": b64u(RA),
    },
    "pairProofKey": pair_key.hex(),
    "pair": {
        "transcript": transcript(b"pair").hex(),
        "offerProof": b64u(mac(pair_key, b"offer" + transcript(b"pair"))),
        "answerProof": b64u(mac(pair_key, b"answer" + transcript(b"pair"))),
    },
    "k": K.hex(),
    "roomId": b32(hkdf(K, b"sd-room")[:16]),
    "ka": KA.hex(),
    "saved": {
        "transcript": transcript(b"saved").hex(),
        "offerProof": b64u(mac(KA, b"offer" + transcript(b"saved"))),
        "answerProof": b64u(mac(KA, b"answer" + transcript(b"saved"))),
    },
    "confirm": {
        "offer": b64u(mac(KA, b"confirmoffer")),
        "answer": b64u(mac(KA, b"confirmanswer")),
    },
}
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vectors.json")
with open(path, "w") as f:
    json.dump(out, f, indent=2)
    f.write("\n")
