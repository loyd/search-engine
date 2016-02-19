(_ => {
"use strict";

let metaTmpl = tmpl('meta-tmpl');
let entryTmpl = tmpl('entry-tmpl');
let offsetTmpl = tmpl('offset-tmpl');

let $form = document.getElementById('search-form');
let $meta = document.getElementById('meta-box');
let $result = document.getElementById('result-box');
let $offset = document.getElementById('offset-box');
let $loader = document.getElementById('loader');

let query = '';

$form.onsubmit = _ => {
  query = $form.query.value;
  $loader.classList.add('show');
  search(query, 0, update);
  return false;
};

$offset.onclick = e => {
  if (!e.target.classList.contains('offset'))
    return;

  $loader.classList.add('show');
  search(query, e.target.dataset.offset, update);
};

function update(err, data) {
  if (err) {
    $result.innerHTML = $offset.innerHTML = '';
    $meta.innerHTML = 'D\'oh! Something is wrong...';
    console.error(err);
    $loader.classList.remove('show');
    return;
  }

  const pageWindow = 5;

  let pageCount = Math.ceil(data.total / data.limit);
  let currentPage = Math.floor(data.offset / data.limit);
  let fromPage = Math.max((currentPage - pageWindow/2|0) + 1, 0);
  let toPage = Math.min(fromPage + pageWindow, pageCount) - 1;

  $meta.innerHTML = metaTmpl({
    total: data.total,
    spent: data.spent / 1000,
    current: currentPage
  });

  $result.innerHTML = data.result.map(entry => entryTmpl({
    score: Math.round(entry.score * 100),
    url: decodeURI(entry.url),
    title: entry.title
  })).join('');

  $offset.innerHTML = offsetTmpl({
    from: fromPage,
    to: toPage,
    count: pageCount,
    current: currentPage,
    limit: data.limit
  });

  $loader.classList.remove('show');
}

function search(query, offset, done) {
  query = encodeURIComponent(query);

  request(`search?q=${query}&o=${offset}`, (err, text) => {
    if (err) return done(err);

    try {
      var result = JSON.parse(text);
    } catch (ex) {
      return done(ex);
    }

    done(null, result);
  });
}

function request(path, done) {
  let xhr = new XMLHttpRequest;
  xhr.open('GET', path, true);
  xhr.send();
  xhr.onreadystatechange = () => {
    if (xhr.readyState !== 4)
      return;

    if (xhr.status !== 200)
      return done(new Error(`Bad response: ${xhr.status} (${xhr.statusText})`));

    done(null, xhr.responseText);
  };
}


// Inspired by http://krasimirtsonev.com/.
function tmpl(id) {
  let html = document.getElementById(id).innerHTML;
  let re = /<%(.+?)%>/g;
  let reExp = /(^( )?(var|if|for|else|switch|case|break|{|}|;))(.*)?/g;
  let code = 'with(__obj) { var r=[];\n';
  let cursor = 0, match, result;

  function add(line, js) {
    js ? (code += line.match(reExp) ? line + '\n' : 'r.push(' + line + ');\n')
       : (code += line != '' ? 'r.push("' + line.replace(/"/g, '\\"') + '");\n' : '');
    return add;
  }

  while (match = re.exec(html)) {
    add(html.slice(cursor, match.index))(match[1], true);
    cursor = match.index + match[0].length;
  }

  add(html.substr(cursor, html.length - cursor));

  code = (code + 'return r.join(""); }').replace(/[\r\t\n]/g, ' ');
  return new Function('__obj', code);
}
})();
