/* ============================================================
   Capri JR31 · Worker de Cloudflare
   - Sirve la app (index.html y archivos) desde el repositorio.
   - /api/ia    → IA de Claude (datos de llamadas, resúmenes, leer capturas).
   - /api/push  → manda notificaciones a los celulares y compus suscritos.
   Secretos (Cloudflare → caprijr31 → Settings → Variables and Secrets):
     ANTHROPIC_API_KEY  · clave de console.anthropic.com
     VAPID_PRIVATE      · llave privada para notificaciones (te la dio Claude)
   ============================================================ */

const VAPID_PUBLIC = 'BJJp4HZxhucD2hSGCHbQFbjzDESswPh-l7hlj4Fmql5zVYKHtXpkgrL8OycmkBDA7CBcUh5f5W8TUGQoNTB5RcA';
const VAPID_SUBJECT = 'mailto:capri1restoration@gmail.com';
const SUPABASE_URL = 'https://qcxrxanvyadewglwszxs.supabase.co';
const SUPABASE_KEY = 'sb_publishable_C5X_h9SYo8kVsYoAxtpxxw_xlc2LMAt';
const IA_MODELO_VISION = 'claude-sonnet-5-5';

function origenOK(o){
  return o === 'https://caprijr31.ing-jaredlaro.workers.dev' || o.startsWith('http://localhost') ;
}

export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);
    if(url.pathname === '/api/ia')    return manejarIA(request, env);
    if(url.pathname === '/api/push')  return manejarPush(request, env, ctx);
    if(url.pathname === '/api/estado') return iaJSON({ia:!!env.ANTHROPIC_API_KEY, push:!!env.VAPID_PRIVATE, vapid:VAPID_PUBLIC});
    return env.ASSETS.fetch(request);
  }
};

/* ---------- Llamada a Claude con respaldo de modelo ---------- */
async function claude(env, body, modelos){
  const lista = modelos || [IA_MODELO];
  let r;
  for(const model of lista){
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'x-api-key':env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},
      body: JSON.stringify({model, ...body})
    });
    if(r.status !== 404 && r.status !== 400) return r;   // si el modelo no existe, prueba el siguiente
  }
  return r;
}

/* ---------- Leer capturas / fotos (incluye letra a mano) ---------- */
async function leerCapturas(b, env){
  const imgs = (Array.isArray(b.imagenes) ? b.imagenes : []).slice(0, 8);
  if(!imgs.length) return iaJSON({error:'Sin imágenes'}, 400);
  const content = [];
  for(const d of imgs){
    const m = String(d).match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/);
    if(!m) continue;
    if(m[2].length > 5_000_000) continue;
    content.push({type:'image', source:{type:'base64', media_type:m[1], data:m[2]}});
  }
  if(!content.length) return iaJSON({error:'Imágenes no válidas'}, 400);
  content.push({type:'text', text:'Transcribe TODO el texto de estas imágenes (capturas de pantalla, notas o letra a mano), en orden, tal cual está escrito, sin resumir. Conserva números, medidas, unidades, nombres, fechas y horas exactamente. Si una parte no se lee, pon [ilegible]. Responde solo con el texto transcrito.'});
  const r = await claude(env, {max_tokens: 3000, messages:[{role:'user', content}]}, [IA_MODELO_VISION, IA_MODELO]);
  if(!r.ok) return iaJSON({error:'La IA respondió '+r.status}, 502);
  const res = await r.json();
  const texto = (res.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('').trim();
  return iaJSON({datos:{texto}});
}

/* ==================== NOTIFICACIONES PUSH (Web Push) ==================== */
const PUSH_VISTAS = new Map();
async function manejarPush(request, env, ctx){
  if(request.method !== 'POST') return iaJSON({error:'Solo POST'}, 405);
  const origen = request.headers.get('Origin') || '';
  if(!origen || !origenOK(origen)) return iaJSON({error:'Origen no permitido'}, 403);
  if(!env.VAPID_PRIVATE) return iaJSON({error:'Falta VAPID_PRIVATE'}, 500);
  const ip = request.headers.get('CF-Connecting-IP') || 'x';
  const ahora=Date.now(), l=(PUSH_VISTAS.get(ip)||[]).filter(t=>ahora-t<600000); l.push(ahora); PUSH_VISTAS.set(ip,l);
  if(l.length > 120) return iaJSON({error:'Demasiados avisos'}, 429);
  let n; try{ n = await request.json(); }catch(e){ return iaJSON({error:'JSON inválido'}, 400); }

  const subs = await sbGet('push_subs?select=*');
  const dep = n.departamento || null;
  const destino = subs.filter(s => {
    if(n.de_usuario_id && s.usuario_id === n.de_usuario_id) return false;       // no a quien lo mandó
    if(n.para_usuario) return s.usuario_id === n.para_usuario;
    if(n.para_rol === 'tecnico') return false;
    if(!['admin','gerente','oficina'].includes(s.rol)) return false;
    if(s.rol === 'admin') return true;                                          // administración oye todo
    return !dep || !s.departamento || s.departamento === 'ambos' || s.departamento === dep;
  });
  const payload = JSON.stringify({
    titulo: String(n.titulo||'Capri JR31').slice(0,120),
    texto: String(n.texto||'').slice(0,240),
    job_id: n.job_id||null, tipo: n.tipo||null, de: n.de_usuario||null
  });
  const trabajo = (async()=>{
    const priv = JSON.parse(env.VAPID_PRIVATE);
    let ok=0, bajas=0;
    for(const s of destino){
      try{
        const r = await enviarWebPush(s, payload, priv);
        if(r.status === 404 || r.status === 410){ bajas++; await sbDelete('push_subs?endpoint=eq.'+encodeURIComponent(s.endpoint)); }
        else if(r.ok) ok++;
      }catch(e){}
    }
    return {ok, bajas};
  })();
  ctx.waitUntil(trabajo);
  return iaJSON({enviando: destino.length});
}

async function sbGet(path){
  const r = await fetch(SUPABASE_URL+'/rest/v1/'+path, {headers:{apikey:SUPABASE_KEY, Authorization:'Bearer '+SUPABASE_KEY}});
  return r.ok ? r.json() : [];
}
async function sbDelete(path){
  await fetch(SUPABASE_URL+'/rest/v1/'+path, {method:'DELETE', headers:{apikey:SUPABASE_KEY, Authorization:'Bearer '+SUPABASE_KEY}});
}

/* ---- Web Push: cifrado aes128gcm (RFC 8291) + firma VAPID (RFC 8292) ---- */
const enc = new TextEncoder();
function b64u(buf){ let s=''; const b=new Uint8Array(buf); for(const x of b) s+=String.fromCharCode(x); return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function unb64u(str){ str=String(str).replace(/-/g,'+').replace(/_/g,'/'); while(str.length%4) str+='='; const s=atob(str); const b=new Uint8Array(s.length); for(let i=0;i<s.length;i++) b[i]=s.charCodeAt(i); return b; }
function concat(...arrs){ const n=arrs.reduce((a,x)=>a+x.length,0); const o=new Uint8Array(n); let p=0; for(const a of arrs){ o.set(a,p); p+=a.length; } return o; }
async function hkdf(salt, ikm, info, len){
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF', hash:'SHA-256', salt, info}, key, len*8));
}
async function vapidJWT(aud, priv){
  const key = await crypto.subtle.importKey('jwk', {...priv, ext:true}, {name:'ECDSA', namedCurve:'P-256'}, false, ['sign']);
  const head = b64u(enc.encode(JSON.stringify({typ:'JWT', alg:'ES256'})));
  const body = b64u(enc.encode(JSON.stringify({aud, exp: Math.floor(Date.now()/1000)+12*3600, sub: VAPID_SUBJECT})));
  const sig = await crypto.subtle.sign({name:'ECDSA', hash:'SHA-256'}, key, enc.encode(head+'.'+body));
  return head+'.'+body+'.'+b64u(sig);
}
async function cifrar(sub, texto){
  const uaPub = unb64u(sub.p256dh), authSecret = unb64u(sub.auth);
  const local = await crypto.subtle.generateKey({name:'ECDH', namedCurve:'P-256'}, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, {name:'ECDH', namedCurve:'P-256'}, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH', public:uaKey}, local.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plain = concat(enc.encode(texto), new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM', iv:nonce}, key, plain));
  const rs = new Uint8Array([0,0,16,0]);  // 4096
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
async function enviarWebPush(sub, texto, priv){
  const u = new URL(sub.endpoint);
  const jwt = await vapidJWT(u.origin, priv);
  const body = await cifrar(sub, texto);
  return fetch(sub.endpoint, {method:'POST', headers:{
    'Authorization': 'vapid t='+jwt+', k='+VAPID_PUBLIC,
    'Content-Encoding': 'aes128gcm', 'Content-Type':'application/octet-stream',
    'TTL':'86400', 'Urgency':'high'
  }, body});
}

/* ==================== IA ==================== */
const IA_MODELO = 'claude-haiku-4-5-20251001';   // rápido y barato para sacar datos
const IA_ORIGEN = 'https://caprijr31.ing-jaredlaro.workers.dev';

// Límite sencillo contra abuso: 30 llamadas por IP cada 10 minutos (por instancia).
const IA_VISTAS = new Map();
function iaLimite(ip){
  const ahora = Date.now(), ventana = 10*60*1000;
  const lista = (IA_VISTAS.get(ip) || []).filter(t => ahora - t < ventana);
  lista.push(ahora); IA_VISTAS.set(ip, lista);
  return lista.length > 30;
}
function iaJSON(obj, status=200){
  return new Response(JSON.stringify(obj), {status, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
}

async function manejarIA(request, env){
  if(request.method !== 'POST') return iaJSON({error:'Solo POST'}, 405);
  const origen = request.headers.get('Origin') || '';
  if(origen && !origenOK(origen)) return iaJSON({error:'Origen no permitido'}, 403);
  if(!env.ANTHROPIC_API_KEY) return iaJSON({error:'Falta ANTHROPIC_API_KEY en Cloudflare'}, 500);
  const ip = request.headers.get('CF-Connecting-IP') || 'x';
  if(iaLimite(ip)) return iaJSON({error:'Demasiadas solicitudes, espera unos minutos'}, 429);

  let b;
  try{ b = await request.json(); }catch(e){ return iaJSON({error:'JSON inválido'}, 400); }
  if(b.tarea === 'resumen') return resumenLlamada(b, env);
  if(b.tarea === 'capturas') return leerCapturas(b, env);
  if(b.tarea !== 'llamada') return iaJSON({error:'Tarea no soportada'}, 400);
  const texto = String(b.texto || '').slice(0, 20000);
  if(texto.length < 15) return iaJSON({error:'Texto muy corto'}, 400);
  const mgs   = (Array.isArray(b.managements) ? b.managements : []).slice(0, 300).map(String);
  const props = (Array.isArray(b.propiedades) ? b.propiedades : []).slice(0, 1500)
                  .map(p => `${String(p.n||'')}${p.mg ? ' ('+String(p.mg)+')' : ''}`);
  const tipos = (Array.isArray(b.tipos) ? b.tipos : []).slice(0, 30).map(String);

  const system = `Eres el asistente de oficina de Capri Restoration Services Inc (San Diego, CA): daños por agua, moho, fuego, reconstrucción y limpieza de alfombras.
Recibes la transcripción automática de una llamada telefónica (puede estar en inglés, español o mezclada, y tener errores de reconocimiento de voz; no se distingue quién habla).
Extrae los datos para abrir un trabajo nuevo. Responde SOLO con un objeto JSON válido, sin texto adicional, con estas llaves:
{
 "cliente": string|null,          // residente o nombre del lugar/cliente
 "quien_llama": string|null,      // nombre y rol de quien llama (ej. "Manny Eslava, service supervisor")
 "telefono": string|null,         // formato 619-555-1234
 "direccion": string|null,        // calle y número
 "ciudad": string|null,
 "zip": string|null,
 "unidad": string|null,           // número de unidad/apartamento
 "management": string|null,       // DEBE ser exactamente uno de la lista de managements, o null
 "propiedad": string|null,        // DEBE ser exactamente uno de la lista de propiedades (solo el nombre, sin el paréntesis), o null
 "origen": "management"|"aseguranza"|"particular",
 "tipo": string,                  // DEBE ser uno de la lista de tipos
 "tipo_propiedad": "apartamento"|"condominio"|"casa"|"comercial"|"otro"|null,
 "ocupada": "ocupada"|"vacia"|null,
 "areas": string[],               // áreas afectadas en inglés corto (ej. "Kitchen","Master bedroom","Hallway")
 "aseguranza": string|null,
 "claim_number": string|null,
 "urgente": boolean,              // true si hay agua activa, inundación, fuga sin parar, moho visible grave, drenaje/sewage o piden ir hoy
 "resumen": string,               // 1 a 3 frases EN ESPAÑOL: qué pasó, qué piden y cuándo
 "scope": string|null             // si mencionan trabajo concreto a realizar, lista breve en inglés; si no, null
}
No inventes datos: si algo no se dijo, usa null. Corrige errores obvios del reconocimiento de voz (nombres de calles de San Diego, números dictados en palabras).`;

  const user = `Managements:\n${mgs.join('\n') || '(ninguno)'}\n\nPropiedades (management entre paréntesis):\n${props.join('\n') || '(ninguna)'}\n\nTipos de servicio:\n${tipos.join(', ')}\n\nTranscripción de la llamada:\n"""\n${texto}\n"""`;

  const r = await claude(env, {max_tokens: 1200, system, messages:[{role:'user', content:user}]});
  if(!r.ok){
    const t = await r.text();
    return iaJSON({error:'La IA respondió '+r.status, detalle:t.slice(0,300)}, 502);
  }
  const res = await r.json();
  const salida = (res.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const m = salida.match(/\{[\s\S]*\}/);
  if(!m) return iaJSON({error:'La IA no devolvió datos'}, 502);
  let datos;
  try{ datos = JSON.parse(m[0]); }catch(e){ return iaJSON({error:'Datos ilegibles'}, 502); }
  return iaJSON({datos});
}


/* Resumen de una llamada interna (ej. Jared con Julio): medidas, acuerdos, pendientes. */
async function resumenLlamada(b, env){
  const texto = String(b.texto || '').slice(0, 40000);
  if(texto.length < 15) return iaJSON({error:'Texto muy corto'}, 400);
  const system = `Eres el asistente de oficina de Capri Restoration Services Inc (San Diego): daños por agua, moho, reconstrucción.
Recibes la transcripción automática de una llamada de trabajo (puede tener errores de reconocimiento de voz; no se distingue quién habla).
Haz notas precisas para que nada se olvide. Responde SOLO con JSON válido:
{
 "resumen": string,        // 2 a 5 frases en español: de qué se habló y qué se decidió
 "medidas": string[],      // cada medida con su lugar, ej. "Baseboard cocina: 13 ft", "Drywall recámara 1: 4x8"
 "acuerdos": string[],     // decisiones tomadas
 "pendientes": string[],   // tareas, quién y para cuándo si se dijo
 "fechas": string[]        // fechas/horas mencionadas con su contexto
}
No inventes nada. Conserva números y unidades exactamente como se dijeron.`;
  const r = await claude(env, {max_tokens: 2000, system,
      messages:[{role:'user', content:'Llamada con: '+String(b.con||'')+'\nAnotó: '+String(b.autor||'')+'\n\nTranscripción:\n'+texto}]});
  if(!r.ok) return iaJSON({error:'La IA respondió '+r.status}, 502);
  const res = await r.json();
  const salida = (res.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('');
  const m = salida.match(/\{[\s\S]*\}/);
  if(!m) return iaJSON({error:'Sin datos'}, 502);
  try{ return iaJSON({datos: JSON.parse(m[0])}); }catch(e){ return iaJSON({error:'Datos ilegibles'}, 502); }
}
