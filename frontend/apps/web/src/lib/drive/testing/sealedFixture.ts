/**
 * Real age v1 files for drive tests. Every test that needs "sealed bytes"
 * takes them from here, so no test hand-writes a fake age header.
 */
import { Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';

/** A real binary age file (X25519 recipient) wrapping `plaintext`. */
export async function sealedFixtureBytes(plaintext: string | Uint8Array = 'almamesh drive fixture'): Promise<Uint8Array> {
  const identity = await generateX25519Identity();
  const encrypter = new Encrypter();
  encrypter.addRecipient(await identityToRecipient(identity));
  return encrypter.encrypt(plaintext);
}

/** A real binary age file sealed with a passphrase (scrypt stanza), the way local export seals. */
export async function passphraseSealedFixtureBytes(plaintext: string | Uint8Array = 'almamesh drive fixture'): Promise<Uint8Array> {
  const encrypter = new Encrypter();
  encrypter.setPassphrase('correct horse battery staple');
  encrypter.setScryptWorkFactor(10);
  return encrypter.encrypt(plaintext);
}
