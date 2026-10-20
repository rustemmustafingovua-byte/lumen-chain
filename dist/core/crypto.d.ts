export type Keypair = {
    privateKey: string;
    publicKey: string;
};
export declare function sha256(data: string | Buffer): string;
/** sha256 в виде Buffer — для Меркла и подписей. */
export declare function sha256Buf(data: string | Buffer): Buffer;
/**
 * Детерминированная пара ключей из 32-байтового seed (RFC 8032).
 * PKCS#8 для ed25519: префикс DER + сам seed; публичный ключ выводится из seed,
 * поэтому адрес всегда один и тот же для одного и того же seed.
 */
export declare function keypairFromSeed(seed: Buffer): Keypair;
export declare function generateKeypair(): Keypair;
export declare function base58(data: Buffer): string;
export declare function base58Decode(s: string): Buffer;
/** Публичный ключ (32 байта) из base64. */
export declare function publicKeyBytes(publicKeyB64: string): Buffer;
/**
 * Адрес: "lmn1" + base58check(version(0x00) || pubkey || checksum4).
 *
 * Ведущий нулевой байт гарантирует, что base58 всегда начинается с "1",
 * а значит адрес всегда читается как "lmn1…". Контрольная сумма — двойной
 * SHA-256 с доменным разделителем "lumen", чтобы адрес нельзя было
 * скопировать из другой сети.
 */
export declare function addressFromPublicKey(publicKeyB64: string, prefix?: string): string;
/** Проверка адреса: префикс сети, длина и контрольная сумма. */
export declare function isValidAddress(address: string): boolean;
export declare function addressFromPrivateKey(privateKeyB64: string, prefix?: string): string;
export declare function sign(privateKeyB64: string, message: Buffer | string): string;
export declare function verify(publicKeyB64: string, message: Buffer | string, signatureB64: string): boolean;
/** Короткий отпечаток адреса для логов. */
export declare function short(addr: string): string;
