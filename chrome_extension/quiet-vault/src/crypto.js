const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export const ITERATIONS = 600_000;
export const MAX_BYTES = 900_000;

export function toBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export function fromBase64(value, expectedLength) {
  if (typeof value !== 'string' || value.length > 1_500_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('Invalid encrypted vault.');
  }
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  if (expectedLength && bytes.length !== expectedLength) throw new Error('Invalid encrypted vault.');
  return bytes;
}

const aad = (owner, purpose) => encoder.encode(`quiet-vault:v1:${owner}:${purpose}`);

async function passwordKey(password, salt, iterations) {
  if (iterations !== ITERATIONS) throw new Error('Unsupported vault encryption version.');
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function seal(key, owner, value, purpose = 'payload') {
  const plaintext = encoder.encode(JSON.stringify(value));
  if (plaintext.length > MAX_BYTES) throw new Error('Vault is full. Remove an item or shorten a value before saving.');
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(owner, purpose) }, key, plaintext);
  return { ciphertext: toBase64(new Uint8Array(encrypted)), nonce: toBase64(nonce) };
}

export async function open(key, owner, envelope, purpose = 'payload') {
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.nonce, 12),
    additionalData: aad(owner, purpose) }, key, fromBase64(envelope.ciphertext));
  return JSON.parse(decoder.decode(plaintext));
}

export async function createVault(owner, password) {
  if (password.length < 12) throw new Error('Use at least 12 characters for your master password.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrappingKey = await passwordKey(password, salt, ITERATIONS);
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  try {
    const wrapNonce = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapNonce,
      additionalData: aad(owner, 'key') }, wrappingKey, rawKey);
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const encrypted = await seal(key, owner, { entries: [] });
    return { key, row: { user_id: owner, format: 1, salt: toBase64(salt), iterations: ITERATIONS,
      wrapped_key: toBase64(new Uint8Array(wrapped)), wrap_nonce: toBase64(wrapNonce), ...encrypted, revision: 1 } };
  } finally { rawKey.fill(0); }
}

export async function unlockVault(owner, password, row) {
  if (row.format !== 1 || row.user_id !== owner) throw new Error('Invalid vault format or account.');
  const wrappingKey = await passwordKey(password, fromBase64(row.salt, 16), row.iterations);
  const rawKey = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(row.wrap_nonce, 12),
    additionalData: aad(owner, 'key') }, wrappingKey, fromBase64(row.wrapped_key, 48)));
  try { return await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']); }
  finally { rawKey.fill(0); }
}


// Rewrap the SAME vault key, preserving every encrypted item/cache/backup.
export async function rewrapVault(owner, oldPassword, newPassword, row) {
  const oldWrapping = await passwordKey(oldPassword, fromBase64(row.salt,16), row.iterations);
  const raw = new Uint8Array(await crypto.subtle.decrypt({ name:'AES-GCM', iv:fromBase64(row.wrap_nonce,12),
    additionalData:aad(owner,'key') }, oldWrapping, fromBase64(row.wrapped_key,48)));
  try {
    const salt=crypto.getRandomValues(new Uint8Array(16));
    const wrapping=await passwordKey(newPassword,salt,ITERATIONS);
    const nonce=crypto.getRandomValues(new Uint8Array(12));
    const wrapped=await crypto.subtle.encrypt({ name:'AES-GCM',iv:nonce,additionalData:aad(owner,'key') },wrapping,raw);
    return { salt:toBase64(salt), wrapped_key:toBase64(new Uint8Array(wrapped)), wrap_nonce:toBase64(nonce) };
  } finally { raw.fill(0); }
}
