const nodeCrypto = require('crypto');
let cachedToken = null;
let tokenExpiresAt = 0;

const BAIDU_API_KEY = process.env.BAIDU_API_KEY;
const BAIDU_SECRET_KEY = process.env.BAIDU_SECRET_KEY;
const ALIYUN_ACCESS_KEY_ID = process.env.ALIYUN_ACCESS_KEY_ID;
const ALIYUN_ACCESS_KEY_SECRET = process.env.ALIYUN_ACCESS_KEY_SECRET;
const ALIYUN_OSS_BUCKET = process.env.ALIYUN_OSS_BUCKET;
const ALIYUN_OSS_REGION = process.env.ALIYUN_OSS_REGION || 'oss-cn-shanghai';
const ALIYUN_OSS_PREFIX = process.env.ALIYUN_OSS_PREFIX || 'yanzhipingfen-celebrity';

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

function hmacSha1Base64(key, text) {
  return nodeCrypto.createHmac('sha1', key).update(text, 'utf8').digest('base64');
}

function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/\!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/'/g, '%27');
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

function aliyunReady() {
  return Boolean(ALIYUN_ACCESS_KEY_ID && ALIYUN_ACCESS_KEY_SECRET && ALIYUN_OSS_BUCKET);
}

async function uploadImageToOss(imageBase64) {
  const endpoint = `${ALIYUN_OSS_REGION}.aliyuncs.com`;
  const objectName = `${ALIYUN_OSS_PREFIX}/${Date.now()}-${nodeCrypto.randomBytes(8).toString('hex')}.jpg`;
  const body = Buffer.from(imageBase64, 'base64');
  const date = new Date().toUTCString();
  const contentType = 'image/jpeg';
  const headers = {
    Date: date,
    'Content-Type': contentType,
    'x-oss-object-acl': 'public-read',
  };
  const ossHeaders = 'x-oss-object-acl:public-read\n';
  const resource = `/${ALIYUN_OSS_BUCKET}/${objectName}`;
  const stringToSign = `PUT\n\n${contentType}\n${date}\n${ossHeaders}${resource}`;
  const signature = hmacSha1Base64(ALIYUN_ACCESS_KEY_SECRET, stringToSign);
  const url = `https://${ALIYUN_OSS_BUCKET}.${endpoint}/${objectName}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      ...headers,
      Authorization: `OSS ${ALIYUN_ACCESS_KEY_ID}:${signature}`,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OSS upload failed with HTTP ${res.status}. ${text.slice(0, 160)}`);
  }
  return url;
}

async function detectCelebrity(imageUrl) {
  const host = 'facebody.cn-shanghai.aliyuncs.com';
  const params = {
    Action: 'DetectCelebrity',
    Version: '2019-12-30',
    Format: 'JSON',
    AccessKeyId: ALIYUN_ACCESS_KEY_ID,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: nodeCrypto.randomBytes(16).toString('hex'),
    Timestamp: new Date().toISOString(),
    ImageURL: imageUrl,
  };
  const sorted = Object.keys(params).sort();
  const canonical = sorted.map(key => `${percentEncode(key)}=${percentEncode(params[key])}`).join('&');
  const stringToSign = `GET&%2F&${percentEncode(canonical)}`;
  const signature = hmacSha1Base64(`${ALIYUN_ACCESS_KEY_SECRET}&`, stringToSign);
  const url = `https://${host}/?${canonical}&Signature=${percentEncode(signature)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.Code) {
    throw new Error(data.Message || data.Code || `DetectCelebrity failed with HTTP ${res.status}.`);
  }
  const results = data.Data?.FaceRecognizeResults || [];
  const list = Array.isArray(results) ? results : [results].filter(Boolean);
  return {
    ok: true,
    provider: 'aliyun-detect-celebrity',
    results: list.map(item => ({
      name: item.Name || item.name || '',
      score: item.Score ?? item.Confidence ?? null,
      faceBoxes: item.FaceBoxes || item.faceBoxes || [],
    })).filter(item => item.name),
    width: data.Data?.Width,
    height: data.Data?.Height,
    requestId: data.RequestId,
  };
}

async function recognizeCelebrity(imageBase64) {
  if (!aliyunReady()) {
    return { ok: false, configured: false, error: 'Aliyun celebrity recognition is not configured.' };
  }
  try {
    const imageUrl = await uploadImageToOss(imageBase64);
    const celebrity = await detectCelebrity(imageUrl);
    return { ...celebrity, configured: true };
  } catch (error) {
    return { ok: false, configured: true, error: error.message || 'Aliyun celebrity recognition failed.' };
  }
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
      hasAliyunAccessKey: Boolean(ALIYUN_ACCESS_KEY_ID),
      hasAliyunSecret: Boolean(ALIYUN_ACCESS_KEY_SECRET),
      hasAliyunOssBucket: Boolean(ALIYUN_OSS_BUCKET),
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
    const [baidu, celebrity] = await Promise.all([
      detectFace(imageBase64),
      recognizeCelebrity(imageBase64),
    ]);
    return response({ ...baidu, celebrity });
  } catch (error) {
    return response({ error: error.message || 'Face detect failed.' }, 500);
  }
};

