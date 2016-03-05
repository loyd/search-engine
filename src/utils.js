"use strict";

import urllib from 'url';
import punycode from 'punycode';


export function normalizeUrl(url) {
  url = url.trim();

  let shorthand = url.startsWith('//');
  let urlObj = urllib.parse(shorthand ? `http:${url}` : url);

  delete urlObj.host;
  delete urlObj.query;
  delete urlObj.hash;

  // Remove default port.
  if (urlObj.port) {
    if (urlObj.protocol === 'http:' && +urlObj.port === 80)
      delete urlObj.port;
    else if (urlObj.protocol === 'https:' && +urlObj.port === 443)
      delete urlObj.port;
  }

  // Replace duplicate slashes.
  if (urlObj.pathname)
    urlObj.pathname = urlObj.pathname.replace(/\/{2,}/g, '/');

  // IDN to unicode and remove "www.".
  if (urlObj.hostname) {
    let hostname = punycode.toUnicode(urlObj.hostname);
    if (hostname.startsWith('www.'))
      hostname = hostname.slice(4);

    urlObj.hostname = hostname;
  }

  url = urllib.format(urlObj);

  // Remove ending "/".
  if (url.endsWith('/'))
    url = url.slice(0, -1);

  // Restore relative protocol.
  if (shorthand)
    url = url.slice(5);

  return url;
}

export function urlObjToKey(urlObj) {
  return urlObj.host + urlObj.pathname.toLowerCase();
}

export function urlToKey(url) {
  return urlObjToKey(urllib.parse(url));
}
