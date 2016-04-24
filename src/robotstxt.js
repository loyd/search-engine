"use strict";


const reUserAgentAny = /^[ \t]*user-agent[ \t]*:[ \t]*\*/mi;
const reUserAgent = /^[ \t]*user-agent[ \t]*:/mi;
const reDisallow = /^[ \t]*disallow[ \t]*:[ \t]*(\/[^\n#]*)/gmi;
const reCrawlDelay = /^[ \t]*crawl-delay[ \t]*:[ \t]*([\d.]+)/mi;
const reEscapeRegex = /[.?+^[\]\\(){}|-]/g;
const reWildcard = /[\*\$]/;
const reAny = /\*/g;

function comparator(a, b) {
  return a.length - b.length;
}

export function parse(content) {
  let start = content.search(reUserAgentAny);
  if (start === -1)
    return {rules: [], crawlDelay: NaN};

  let rules = [];
  let reRules = [];

  let useful = content.slice(start + 13);
  let end = useful.search(reUserAgent);
  if (~end)
    useful = useful.slice(0, end);

  let result;
  while (result = reDisallow.exec(useful)) {
    let path = result[1].trim();

    // We ignore dynamic pages hence this rule is useless.
    if (~path.indexOf('?'))
      continue;

    // `/path/to/filename*` === `/path/to/filename`.
    if (path[path.length - 1] === '*')
      path = path.slice(0, -1);

    if (reWildcard.test(path)) {
      reRules.push(new RegExp('^' + path.replace(reEscapeRegex, '\\$&').replace(reAny, '.*')));
    } else
      rules.push(path);
  }

  rules.sort(comparator);
  rules.push(...reRules);

  result = useful.match(reCrawlDelay)
  let crawlDelay = result ? +result[1] : NaN;

  return {rules, crawlDelay};
}

export function isDisallowed(rules, path) {
  for (let rule of rules)
    if (typeof rule === 'string' ? path.startsWith(rule) : rule.test(path))
      return true;

  return false;
}
