import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { env, ACCESS_TTL_S, REFRESH_TTL_S } from './env';

const accessKey = new TextEncoder().encode(env.JWT_SECRET);
const refreshKey = new TextEncoder().encode(env.JWT_REFRESH_SECRET);

export interface AccessPayload {
  sub: string; // user id
  rol: 'super_admin' | 'coach' | 'user';
  nombre: string;
}

export interface RefreshPayload {
  sub: string;
  jti: string;
}

// Claims internos que extienden JWTPayload para usar con el genérico de jwtVerify
interface AccessClaims extends JWTPayload {
  sub: string;
  rol: 'super_admin' | 'coach' | 'user';
  nombre: string;
}

interface RefreshClaims extends JWTPayload {
  sub: string;
  jti: string;
}

export async function signAccess(payload: AccessPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_S}s`)
    .setIssuer('fitvang')
    .sign(accessKey);
}

export async function signRefresh(payload: RefreshPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${REFRESH_TTL_S}s`)
    .setIssuer('fitvang')
    .sign(refreshKey);
}

export async function verifyAccess(token: string): Promise<AccessPayload | null> {
  try {
    const { payload } = await jwtVerify<AccessClaims>(token, accessKey, { issuer: 'fitvang' });
    return { sub: payload.sub, rol: payload.rol, nombre: payload.nombre };
  } catch {
    return null;
  }
}

export async function verifyRefresh(token: string): Promise<RefreshPayload | null> {
  try {
    const { payload } = await jwtVerify<RefreshClaims>(token, refreshKey, { issuer: 'fitvang' });
    return { sub: payload.sub, jti: payload.jti };
  } catch {
    return null;
  }
}
