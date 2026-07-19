import type { Ledger, Vault } from "@/lib/vault-types";

export const bytes = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const b64 = (b: ArrayBuffer | Uint8Array): string => {
  const a = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (let i = 0; i < a.length; i += 32768) s += String.fromCharCode(...a.subarray(i, i + 32768));
  return btoa(s);
};

export const url64 = (b: ArrayBuffer | Uint8Array): string => {
  const a = b instanceof Uint8Array ? b : new Uint8Array(b);
  return btoa(String.fromCharCode(...a))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

export const fromUrl64 = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(
    atob(
      s
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(s.length / 4) * 4, "=")
    ),
    (c) => c.charCodeAt(0)
  );

export const aesKey = (secret: ArrayBuffer): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", secret, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

export async function contentEtag(raw: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return `"${Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}"`;
}

async function keyFor(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  it: number
): Promise<CryptoKey> {
  const m = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations: it, hash: "SHA-256" },
    m,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function decryptVault(v: Vault, password: string): Promise<Ledger> {
  const key = await keyFor(password, bytes(v.salt), v.iterations),
    cipher = bytes(v.ciphertext),
    tag = bytes(v.tag),
    joined = new Uint8Array(cipher.length + tag.length);
  joined.set(cipher);
  joined.set(tag, cipher.length);
  const zipped = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes(v.iv) },
    key,
    joined.buffer as ArrayBuffer
  );
  const stream = new Blob([zipped]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text()) as Ledger;
}

export async function encryptVault(
  data: Ledger,
  password: string
): Promise<{
  version: number;
  algorithm: string;
  kdf: string;
  iterations: number;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}> {
  const iterations = 600000,
    salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12)),
    key = await keyFor(password, salt, iterations),
    stream = new Blob([JSON.stringify(data)]).stream().pipeThrough(new CompressionStream("gzip")),
    zipped = await new Response(stream).arrayBuffer(),
    sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, zipped));
  return {
    version: 1,
    algorithm: "AES-256-GCM",
    kdf: "PBKDF2-SHA256",
    iterations,
    salt: b64(salt),
    iv: b64(iv),
    tag: b64(sealed.slice(-16)),
    ciphertext: b64(sealed.slice(0, -16)),
  };
}
