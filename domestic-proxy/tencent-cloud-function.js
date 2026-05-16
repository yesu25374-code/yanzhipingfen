const nodeCrypto = require('crypto');
let cachedToken = null;
let tokenExpiresAt = 0;

const BAIDU_API_KEY = process.env.BAIDU_API_KEY;
const BAIDU_SECRET_KEY = process.env.BAIDU_SECRET_KEY;
const TENCENT_SECRET_ID = process.env.TENCENT_SECRET_ID;
const TENCENT_SECRET_KEY = process.env.TENCENT_SECRET_KEY;

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

function sha256Hex(text) {
  return nodeCrypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function hmac(key, text) {
  return nodeCrypto.createHmac('sha256', key).update(text, 'utf8').digest();
}

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
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

async function detectTencentFace(imageBase64) {
  if (!TENCENT_SECRET_ID || !TENCENT_SECRET_KEY) {
    return { ok: false, error: 'Missing Tencent API credentials.' };
  }

  const host = 'iai.tencentcloudapi.com';
  const service = 'iai';
  const action = 'DetectFaceAttributes';
  const version = '2020-03-03';
  const region = 'ap-guangzhou';
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const payload = JSON.stringify({
    Image: imageBase64,
    MaxFaceNum: 1,
    FaceAttributesType: 'Age,Beauty,Gender,Headpose,Eye,Eyebrow,Nose,Shape,Skin,Smile,Hair',
    FaceModelVersion: '3.0',
  });

  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const hashedPayload = sha256Hex(payload);
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;
  const secretDate = await hmac(`TC3${TENCENT_SECRET_KEY}`, date);
  const secretService = await hmac(secretDate, service);
  const secretSigning = await hmac(secretService, 'tc3_request');
  const signature = hex(await hmac(secretSigning, stringToSign));
  const authorization = `TC3-HMAC-SHA256 Credential=${TENCENT_SECRET_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`https://${host}`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json; charset=utf-8',
      Host: host,
      'X-TC-Action': action,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': version,
      'X-TC-Region': region,
    },
    body: payload,
  });

  const data = await res.json();
  const response = data.Response || {};
  if (!res.ok || response.Error) {
    return { ok: false, error: response.Error?.Message || `Tencent face failed with HTTP ${res.status}.`, code: response.Error?.Code };
  }

  const face = response.FaceDetailInfos?.[0] || {};
  const attrs = face.FaceDetailAttributesInfo || {};
  const beautyRaw = Number(attrs.Beauty || 0);
  const sixDimBeauty = estimateTencentSixDimScore(attrs);
  return {
    ok: true,
    provider: 'tencent-iai-detect-face-attributes',
    beauty: beautyRaw > 0 ? beautyRaw : sixDimBeauty,
    beautyRaw,
    beautySource: beautyRaw > 0 ? 'beauty' : 'six-dim',
    sixDimBeauty,
    age: attrs.Age,
    gender: attrs.Gender,
    headPose: attrs.HeadPose,
    eye: attrs.Eye,
    eyebrow: attrs.Eyebrow,
    nose: attrs.Nose,
    shape: attrs.Shape,
    skin: attrs.Skin,
    smile: attrs.Smile,
    hair: attrs.Hair,
    faceRect: face.FaceRect,
    requestId: response.RequestId,
  };
}

function toScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(0, Math.min(100, n));
}

function avgScores(values, fallback = null) {
  const nums = values.map(toScore).filter(v => v !== null);
  if (!nums.length) return fallback;
  return nums.reduce((sum, v) => sum + v, 0) / nums.length;
}

function collectScores(value, keys = []) {
  if (!value || typeof value !== 'object') return [];
  const out = [];
  for (const [key, child] of Object.entries(value)) {
    if (!keys.length || keys.includes(key)) {
      const score = toScore(child);
      if (score !== null) out.push(score);
    }
    if (child && typeof child === 'object') out.push(...collectScores(child, keys));
  }
  return out;
}

function estimateTencentSixDimScore(attrs) {
  const eye = avgScores(collectScores(attrs.Eye), null);
  const eyebrow = avgScores(collectScores(attrs.Eyebrow), null);
  const nose = avgScores(collectScores(attrs.Nose), null);
  const shape = avgScores(collectScores(attrs.Shape), null);
  const skin = avgScores(collectScores(attrs.Skin), null);
  const hair = avgScores(collectScores(attrs.Hair), null);
  const expression = avgScores([attrs.Smile], null);
  const dims = [
    { value: eye, weight: 0.22 },
    { value: eyebrow, weight: 0.12 },
    { value: nose, weight: 0.18 },
    { value: shape, weight: 0.20 },
    { value: skin, weight: 0.13 },
    { value: avgScores([hair, expression], null), weight: 0.15 },
  ].filter(item => item.value !== null);
  if (!dims.length) return 0;
  const totalWeight = dims.reduce((sum, item) => sum + item.weight, 0);
  const score = dims.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight;
  return Number(score.toFixed(2));
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
      hasTencentSecretId: Boolean(TENCENT_SECRET_ID),
      hasTencentSecretKey: Boolean(TENCENT_SECRET_KEY),
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
    const [baidu, tencent] = await Promise.all([
      detectFace(imageBase64),
      detectTencentFace(imageBase64).catch(error => ({ ok: false, error: error.message || 'Tencent face failed.' })),
    ]);
    return response({ ...baidu, tencent });
  } catch (error) {
    return response({ error: error.message || 'Face detect failed.' }, 500);
  }
};

