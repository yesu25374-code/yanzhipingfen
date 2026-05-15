let cachedToken = null;
let tokenExpiresAt = 0;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function cleanBase64(image) {
  if (typeof image !== 'string') return '';
  return image.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').trim();
}

async function getToken(env) {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const url = new URL('https://aip.baidubce.com/oauth/2.0/token');
  url.searchParams.set('grant_type', 'client_credentials');
  url.searchParams.set('client_id', env.BAIDU_API_KEY);
  url.searchParams.set('client_secret', env.BAIDU_SECRET_KEY);

  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Failed to get access_token.');
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + Math.max(60, Number(data.expires_in || 2592000) - 300) * 1000;
  return cachedToken;
}

async function detectFace(imageBase64, env) {
  const token = await getToken(env);
  const url = `https://aip.baidubce.com/rest/2.0/face/v3/detect?access_token=${encodeURIComponent(token)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image: imageBase64,
      image_type: 'BASE64',
      face_field: 'beauty,age,gender,face_shape,quality,angle,glasses,mask,expression',
      max_face_num: 5,
      face_type: 'LIVE',
    }),
  });

  const data = await response.json();
  if (!response.ok || data.error_code) {
    throw new Error(data.error_msg || `Face detect failed with HTTP ${response.status}.`);
  }

  const faceList = data.result?.face_list || [];
  if (!faceList.length) throw new Error('No face detected.');
  faceList.sort((a, b) => (b.location?.width || 0) * (b.location?.height || 0) - (a.location?.width || 0) * (a.location?.height || 0));
  const face = faceList[0];

  return {
    provider: 'baidu-face-v3',
    face_num: data.result.face_num,
    face_token: face.face_token,
    location: face.location,
    beauty: Number(face.beauty || 0),
    age: face.age,
    gender: face.gender,
    face_shape: face.face_shape,
    quality: face.quality,
    angle: face.angle,
    glasses: face.glasses,
    mask: face.mask,
    expression: face.expression,
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({
        ok: true,
        provider: 'baidu-face-v3',
        keyTail: String(env.BAIDU_API_KEY || '').slice(-6),
        hasApiKey: Boolean(env.BAIDU_API_KEY),
        hasSecretKey: Boolean(env.BAIDU_SECRET_KEY),
        tokenCached: Boolean(cachedToken),
      });
    }

    if (request.method !== 'POST') return json({ error: 'Use POST with image base64.' }, 405);

    try {
      const body = await request.json();
      const imageBase64 = cleanBase64(body.image);
      if (!imageBase64) return json({ error: 'Missing image base64 parameter.' }, 400);
      return json(await detectFace(imageBase64, env));
    } catch (error) {
      return json({ error: error.message || 'Face detect failed.' }, 500);
    }
  },
};
