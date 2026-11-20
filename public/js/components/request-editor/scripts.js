export function createScriptsPanel(onCountChange = () => {}) {
  const panel = document.createElement('div');
  const hint = document.createElement('p');
  hint.className = 'ext-hint';
  hint.textContent = 'Custom JavaScript can run before or after this request. Values assigned to vars.name can be reused as {{name}}.';
  const preLabel = document.createElement('label');
  preLabel.className = 'script-label';
  preLabel.textContent = 'Pre-processor — runs before the request';
  const pre = document.createElement('textarea');
  pre.className = 'pre-script';
  pre.setAttribute('aria-label', 'Pre-request processor script');
  pre.placeholder = "vars.timestamp = Date.now();\nvars.trace_id = 'trace-' + __VU + '-' + __ITER;";
  const postLabel = document.createElement('label');
  postLabel.className = 'script-label';
  postLabel.textContent = 'Post-processor — runs after the response (as “res”)';
  const post = document.createElement('textarea');
  post.className = 'post-script';
  post.setAttribute('aria-label', 'Post-request processor script');
  post.placeholder = '// “res” is this request response\nconst data = JSON.parse(res.body);\nvars.first_id = data.items[0].id;';
  [pre, post].forEach(input => input.addEventListener('input', onCountChange));
  panel.append(hint, preLabel, pre, postLabel, post);
  return panel;
}
