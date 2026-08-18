import { handleCheckRoute } from '@/lib/checkRoute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handleCheckRoute(request, 'emailSecurity');
}
