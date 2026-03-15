// Utilities to safely encode/decode between Base64, strings, and ArrayBuffers
export const ab2base64 = (buf) => btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
export const base642ab = (str) => new Uint8Array(atob(str).split('').map(c => c.charCodeAt(0))).buffer;

export const generateECDHKeyPair = async () => {
  const keyPair = await window.crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-384" },
    true, // extractable
    ["deriveKey", "deriveBits"]
  );
  
  const publicKeyRaw = await window.crypto.subtle.exportKey("spki", keyPair.publicKey);
  const publicKeyBase64 = ab2base64(publicKeyRaw);

  return { keyPair, publicKeyBase64 };
};

export const importPublicKey = async (publicKeyBase64) => {
  const publicKeyRaw = base642ab(publicKeyBase64);
  return await window.crypto.subtle.importKey(
    "spki",
    publicKeyRaw,
    { name: "ECDH", namedCurve: "P-384" },
    true,
    []
  );
};

// Derive an AES-GCM shared key from our private key and their public key
export const deriveAESKey = async (privateKey, publicKey) => {
  return await window.crypto.subtle.deriveKey(
    {
      name: "ECDH",
      public: publicKey
    },
    privateKey,
    {
      name: "AES-GCM",
      length: 256
    },
    true,
    ["encrypt", "decrypt"]
  );
};

export const encryptText = async (text, aesKey) => {
  const enc = new TextEncoder();
  const encodedText = enc.encode(text);
  
  // Initialization Vector (IV) is necessary for AES-GCM
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  
  const cipherText = await window.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv
    },
    aesKey,
    encodedText
  );

  return {
    cipherText: ab2base64(cipherText),
    iv: ab2base64(iv)
  };
};

export const decryptText = async (cipherTextBase64, ivBase64, aesKey) => {
  const cipherText = base642ab(cipherTextBase64);
  const iv = base642ab(ivBase64);

  const decryptedAb = await window.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: iv
    },
    aesKey,
    cipherText
  );

  const dec = new TextDecoder();
  return dec.decode(decryptedAb);
};

// --- Media Encryption Helpers ---
export const encryptMedia = async (arrayBuffer, aesKey) => {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  
  const cipherTextAb = await window.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv
    },
    aesKey,
    arrayBuffer
  );

  return {
    cipherTextBlob: new Blob([cipherTextAb]), // Store as Blob for Firebase upload
    iv: ab2base64(iv)
  };
};

export const decryptMedia = async (cipherTextAb, ivBase64, aesKey) => {
  const iv = base642ab(ivBase64);

  const decryptedAb = await window.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: iv
    },
    aesKey,
    cipherTextAb
  );

  return new Blob([decryptedAb]); // Return as Blob for Object URL creation
};

// --- New Storage Helpers ---
export const exportPrivateKeyJWK = async (privateKey) => {
  return await window.crypto.subtle.exportKey("jwk", privateKey);
};

export const importPrivateKeyJWK = async (jwk) => {
  return await window.crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-384" },
    true,
    ["deriveKey", "deriveBits"]
  );
};

