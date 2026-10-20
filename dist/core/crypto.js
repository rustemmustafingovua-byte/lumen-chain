/**
 * Lumen — криптография и адреса.
 *
 * ed25519 (RFC 8032) через node:crypto, SHA-256 для хэшей, base58check-подобный
 * адрес с префиксом сети и контрольной суммой.
 */
import { createHash, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, createPrivateKey } from "node:crypto";
export function sha256(data) {
    return createHash("sha256").update(data).digest("hex");
}
/** sha256 в виде Buffer — для Меркла и подписей. */
export function sha256Buf(data) {
    return createHash("sha256").update(data).digest();
}
/**
 * Детерминированная пара ключей из 32-байтового seed (RFC 8032).
 * PKCS#8 для ed25519: префикс DER + сам seed; публичный ключ выводится из seed,
 * поэтому адрес всегда один и тот же для одного и того же seed.
 */
export function keypairFromSeed(seed) {
    if (seed.length !== 32)
        throw new Error("seed must be 32 bytes");
    const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
    const key = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
    const pub = createPublicKey(key).export({ type: "spki", format: "der" }).subarray(12);
    return { privateKey: pkcs8.toString("base64"), publicKey: pub.toString("base64") };
}
export function generateKeypair() {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
        privateKeyEncoding: { type: "pkcs8", format: "der" },
        publicKeyEncoding: { type: "spki", format: "der" },
    });
    return { privateKey: privateKey.toString("base64"), publicKey: publicKey.toString("base64") };
}
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(data) {
    let n = BigInt("0x" + (data.toString("hex") || "0"));
    let out = "";
    while (n > 0n) {
        const rem = Number(n % 58n);
        n = n / 58n;
        out = B58[rem] + out;
    }
    for (const byte of data) {
        if (byte !== 0)
            break;
        out = "1" + out;
    }
    return out || "1";
}
export function base58Decode(s) {
    let n = 0n;
    for (const ch of s) {
        const i = B58.indexOf(ch);
        if (i < 0)
            throw new Error("bad base58");
        n = n * 58n + BigInt(i);
    }
    let hex = n.toString(16);
    if (hex.length % 2)
        hex = "0" + hex;
    let out = Buffer.from(hex, "hex");
    let zeros = 0;
    for (const ch of s) {
        if (ch !== "1")
            break;
        zeros++;
    }
    return Buffer.concat([Buffer.alloc(zeros), out]);
}
/** Публичный ключ (32 байта) из base64. */
export function publicKeyBytes(publicKeyB64) {
    const raw = Buffer.from(publicKeyB64, "base64");
    return raw.length === 32 ? raw : raw.subarray(raw.length - 32);
}
/**
 * Адрес: "lmn1" + base58check(version(0x00) || pubkey || checksum4).
 *
 * Ведущий нулевой байт гарантирует, что base58 всегда начинается с "1",
 * а значит адрес всегда читается как "lmn1…". Контрольная сумма — двойной
 * SHA-256 с доменным разделителем "lumen", чтобы адрес нельзя было
 * скопировать из другой сети.
 */
export function addressFromPublicKey(publicKeyB64, prefix = "lmn") {
    const pub = publicKeyBytes(publicKeyB64);
    const body = Buffer.concat([Buffer.from([0x00]), pub]);
    const checksum = sha256Buf(sha256Buf(Buffer.concat([Buffer.from("lumen"), body]))).subarray(0, 4);
    return prefix + base58(Buffer.concat([body, checksum]));
}
/** Проверка адреса: префикс сети, длина и контрольная сумма. */
export function isValidAddress(address) {
    if (!/^lmn1[1-9A-HJ-NP-Za-km-z]{32,60}$/.test(address))
        return false;
    const raw = base58Decode(address.slice(3));
    if (raw.length !== 37)
        return false;
    const body = raw.subarray(0, 33);
    const checksum = raw.subarray(33);
    const expected = sha256Buf(sha256Buf(Buffer.concat([Buffer.from("lumen"), body]))).subarray(0, 4);
    return checksum.equals(expected);
}
export function addressFromPrivateKey(privateKeyB64, prefix = "lmn") {
    const key = createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
    const pub = createPublicKey(key).export({ type: "spki", format: "der" }).subarray(12);
    return addressFromPublicKey(pub.toString("base64"), prefix);
}
export function sign(privateKeyB64, message) {
    const key = createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
    const data = typeof message === "string" ? Buffer.from(message) : message;
    return edSign(null, data, key).toString("base64");
}
export function verify(publicKeyB64, message, signatureB64) {
    try {
        const pub = publicKeyBytes(publicKeyB64);
        const der = Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"),
            pub,
        ]);
        const key = createPublicKey({ key: der, format: "der", type: "spki" });
        const data = typeof message === "string" ? Buffer.from(message) : message;
        return edVerify(null, data, key, Buffer.from(signatureB64, "base64"));
    }
    catch {
        return false;
    }
}
/** Короткий отпечаток адреса для логов. */
export function short(addr) {
    return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
