import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { exportPublicKey, exportSecretKey, generateKeyPair, importPublicKey, importSecretKey, type KeyPair } from "@getpaseo/relay/e2ee";
import { readJson, writeJsonAtomic } from "./fsutil.ts";
import { IDENTITY_FILE } from "./paths.ts";

export interface IdentityFile { hostId: string; publicKey: string; secretKey: string; createdAt: string }
export interface Identity extends IdentityFile { keyPair: KeyPair }

export function identityExists(): boolean { return existsSync(IDENTITY_FILE); }

export function createIdentity(): IdentityFile {
  const kp = generateKeyPair();
  const id: IdentityFile = {
    hostId: randomBytes(16).toString("base64url"),
    publicKey: exportPublicKey(kp.publicKey),
    secretKey: exportSecretKey(kp.secretKey),
    createdAt: new Date().toISOString(),
  };
  writeJsonAtomic(IDENTITY_FILE, id);
  return id;
}

export function validateIdentity(v: unknown): IdentityFile {
  const o = v as IdentityFile;
  if (!o || typeof o.hostId !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(o.hostId)
    || typeof o.publicKey !== "string" || typeof o.secretKey !== "string") {
    throw new Error("invalid identity: expected hostId, publicKey, secretKey");
  }
  importPublicKey(o.publicKey);
  importSecretKey(o.secretKey);
  return { hostId: o.hostId, publicKey: o.publicKey, secretKey: o.secretKey, createdAt: o.createdAt ?? new Date().toISOString() };
}

export function loadIdentity(): Identity {
  const raw = readJson<IdentityFile>(IDENTITY_FILE);
  if (!raw) throw new Error(`identity not found at ${IDENTITY_FILE}; run "pi-hostd init" first`);
  const f = validateIdentity(raw);
  return { ...f, keyPair: { publicKey: importPublicKey(f.publicKey), secretKey: importSecretKey(f.secretKey) } };
}
