// Buy Me a Coffee → BAZINGA! tippers leaderboard.
// Deploy:  supabase functions deploy bmc-webhook --no-verify-jwt
// Secrets: supabase secrets set BMC_WEBHOOK_SECRET=<the secret shown for your webhook on buymeacoffee.com>
// Then in Buy Me a Coffee → Integrations → Webhooks, add:
//   https://<your-project>.supabase.co/functions/v1/bmc-webhook   (events: donation / support / membership)
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const SECRET = Deno.env.get('BMC_WEBHOOK_SECRET') || '';

async function hmacHex(body: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function sha(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s.trim().toLowerCase()));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

Deno.serve(async req => {
  if (req.method !== 'POST') return new Response('ok');
  const body = await req.text();
  if (SECRET) {
    const got = (req.headers.get('x-signature-sha256') || req.headers.get('x-bmc-signature') || '').toLowerCase();
    if (!got || got !== await hmacHex(body)) return new Response('bad signature', { status: 401 });
  }
  let j: any; try { j = JSON.parse(body); } catch { return new Response('bad json', { status: 400 }); }
  const type = String(j.type || req.headers.get('x-bmc-event') || '');
  const d = j.data || j.response || {};
  const refund = /refund/i.test(type);
  if (type && !/donation|support|coffee|membership|extra|refund/i.test(type)) return new Response('ignored');
  const amount = Number(d.amount ?? d.total_amount ?? d.total_amount_charged ?? 0) || 0;
  const coffees = Number(d.coffee_count ?? d.number_of_coffees ?? 0) || 0;
  // Names stay as the supporter typed them on Buy Me a Coffee; "Someone" means they chose to stay anonymous.
  let name = String(d.supporter_name ?? d.supporter_name_full ?? '').trim();
  if (!name || /^someone$/i.test(name) || d.supporter_name_type === 'anonymous') name = 'Anonymous';
  const id = d.supporter_id ? 'bmc:' + d.supporter_id : 'e:' + await sha(String(d.supporter_email || name + Math.random()));
  const { error } = await db.rpc('add_tip', {
    p_event: String(j.event_id || d.transaction_id || d.id || '') || null,
    p_id: id, p_name: name, p_amount: refund ? -amount : amount, p_currency: String(d.currency || 'USD'), p_coffees: refund ? -coffees : coffees
  });
  if (error) return new Response(error.message, { status: 500 });
  return new Response('ok');
});
