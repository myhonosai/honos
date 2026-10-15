import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { verify, type JwtPayload } from 'jsonwebtoken';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const token = (await cookies()).get('webdev_app_session')?.value;
  if (!token) return NextResponse.json({ code: 'UNAUTHENTICATED', detail: 'HON requires an authenticated application session.' }, { status: 401 });
  const secret = process.env.MANUS_JWT_SECRET;
  const projectId = process.env.MANUS_PROJECT_ID;
  if (!secret || !projectId) return NextResponse.json({ code: 'IDENTITY_NOT_CONFIGURED', detail: 'HON application identity validation is not configured.' }, { status: 503 });
  try {
    const payload = verify(token, secret, { algorithms: ['HS256'] }) as JwtPayload;
    if (payload.appId !== projectId) return NextResponse.json({ code: 'UNAUTHENTICATED', detail: 'HON rejected a session issued for another application.' }, { status: 401 });
    const externalSubject = typeof payload.openId === 'string' ? payload.openId : typeof payload.sub === 'string' ? payload.sub : undefined;
    if (!externalSubject) return NextResponse.json({ code: 'UNAUTHENTICATED', detail: 'HON session has no usable identity subject.' }, { status: 401 });
    const displayName = typeof payload.name === 'string' ? payload.name : undefined;
    const email = typeof payload.email === 'string' ? payload.email : undefined;
    return NextResponse.json({ data: { externalSubject, displayName, email } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ code: 'UNAUTHENTICATED', detail: 'HON could not validate the application session.' }, { status: 401 });
  }
}
