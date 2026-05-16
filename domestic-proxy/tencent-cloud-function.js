let cachedToken = null;
let tokenExpiresAt = 0;

const BAIDU_API_KEY = process.env.BAIDU_API_KEY;
const BAIDU_SECRET_KEY = process.env.BAIDU_SECRET_KEY;

function methodOf(event) {
  return event.httpMethod || event.requestContext?.http?.method || event.requestContext?.httpMethod || 'GET';
}

function response(payload, statusCode = 200) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
  };
}

function cleanBase64(image) {
  if (typeof image !== 'string') return '';
  return image.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').trim();
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const url = new URL('https://aip.baidubce.com/oauth/2.0/token');
  url.searchParams.set('grant_type', 'client_credentials');
  url.searchParams.set('client_id', BAIDU_API_KEY);
  url.searchParams.set('client_secret', BAIDU_SECRET_KEY);

  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Failed to get access_token.');
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + Math.max(60, Number(data.expires_in || 2592000) - 300) * 1000;
  return cachedToken;
}

async function detectFace(imageBase64) {
  const token = await getToken();
  const url = `https://aip.baidubce.com/rest/2.0/face/v3/detect?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
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

  const data = await res.json();
  if (!res.ok || data.error_code) {
    throw new Error(data.error_msg || `Face detect failed with HTTP ${res.status}.`);
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

exports.main_handler = async (event) => {
  const method = methodOf(event);
  if (method === 'OPTIONS') return response({}, 204);

  if (method === 'GET') {
    return response({
      ok: true,
      provider: 'baidu-face-v3',
      hasApiKey: Boolean(BAIDU_API_KEY),
      hasSecretKey: Boolean(BAIDU_SECRET_KEY),
      tokenCached: Boolean(cachedToken),
    });
  }

  if (method !== 'POST') return response({ error: 'Use POST with image base64.' }, 405);

  try {
    const rawBody = event.isBase64Encoded && typeof event.body === 'string'
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    const body = typeof rawBody === 'string' ? JSON.parse(rawBody || '{}') : (rawBody || {});
    const imageBase64 = cleanBase64(body.image);
    if (!imageBase64) return response({ error: 'Missing image base64 parameter.' }, 400);
    return response(await detectFace(imageBase64));
  } catch (error) {
    return response({ error: error.message || 'Face detect failed.' }, 500);
  }
};
