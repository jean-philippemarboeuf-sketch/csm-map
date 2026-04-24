exports.handler = async (event) => {
  const token = process.env.HS_TOKEN;
  if (!token) return { statusCode: 500, body: JSON.stringify({ error: 'Token non configuré' }) };

  const path = event.queryStringParameters?.path || '';
  const url = `https://api.hubapi.com${path}`;

  const options = {
    method: event.httpMethod === 'POST' ? 'POST' : 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };
  if (event.body) options.body = event.body;

  try {
    const res = await fetch(url, options);
    const data = await res.text();
    return {
      statusCode: res.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: data
    };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
