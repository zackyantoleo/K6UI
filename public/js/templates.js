// Starting points of the first-run screen (Build Flow of an empty project). A
// template is an ordinary project in the existing schema: requests, variables and
// extractions, nothing new. Pure, no DOM; components/first-run.js applies it.

// Local by default, so a run started before the values are changed never sends
// load to someone else's server.
export const LOGIN_TEMPLATE_VARIABLES = Object.freeze([
  Object.freeze({ key: 'base_url', value: 'http://localhost:8080' }),
  Object.freeze({ key: 'username', value: 'test_user' }),
  Object.freeze({ key: 'password', value: 'change_me' }),
]);

// "Log in, then use the token": a POST that takes {{token}} from its JSON response,
// then a GET that sends it in the Authorization header.
export function loginTemplateRequests([loginId, profileId]) {
  return [
    {
      id: loginId, name: 'Log in', enabled: true, type: 'http', method: 'POST', url: '{{base_url}}/login',
      headers: [{ key: 'Content-Type', value: 'application/json' }],
      body: '{\n  "username": "{{username}}",\n  "password": "{{password}}"\n}',
      checkStatus: true, sleepAfter: '1',
      extractions: [{ varName: 'token', source: 'json', selector: 'token' }],
    },
    {
      id: profileId, name: 'Use the token', enabled: true, type: 'http', method: 'GET', url: '{{base_url}}/me',
      headers: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
      body: '', checkStatus: true, sleepAfter: '1',
    },
  ];
}

// The project with the template's requests after its own and the template's
// variables it does not have yet (a variable it has keeps its value).
export function withLoginTemplate(config, ids) {
  const source = config && typeof config === 'object' ? config : {};
  const variables = Array.isArray(source.variables) ? [...source.variables] : [];
  for (const variable of LOGIN_TEMPLATE_VARIABLES) {
    if (!variables.some(item => item?.key === variable.key)) variables.push({ ...variable });
  }
  const scenario = source.scenario && typeof source.scenario === 'object' ? source.scenario : {};
  return {
    ...source,
    variables,
    scenario: {
      ...scenario,
      groups: Array.isArray(scenario.groups) ? scenario.groups : [],
      requests: [...(Array.isArray(scenario.requests) ? scenario.requests : []), ...loginTemplateRequests(ids)],
    },
  };
}
