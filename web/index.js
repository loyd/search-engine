(_ => {
"use strict";

let metaTmpl = tmpl('meta-tmpl');
let entryTmpl = tmpl('entry-tmpl');

let $form = document.getElementById('search-form');
let $meta = document.getElementById('meta-box');
let $result = document.getElementById('result-box');

$form.onsubmit = _ => {
  search($form.query.value, update);
  return false;
};

function update({spent, total, result}) {
  $meta.innerHTML = metaTmpl({total, spent: spent / 1000});
  $result.innerHTML = result.map(entry => entryTmpl({
    score: Math.round(entry.score * 100),
    url: decodeURI(entry.url),
    title: entry.title
  })).join('');
}

function search(query, done) {
  request(`search?q=${query}`, text => {
    try {
      var result = JSON.parse(text);
    } catch (ex) {
      console.error('Ooops', ex);
      return;
    }

    done(result);
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
      console.error('%d: %s', xhr.status, xhr.statusText);

    done(xhr.responseText);
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
