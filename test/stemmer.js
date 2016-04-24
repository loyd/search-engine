"use strict";

import assert from 'assert';

import Stemmer from '../src/stemmer';


let stemmer = new Stemmer();

function testStem() {
  assert.equal(stemmer.stem('программирование'), 'программирован');
  assert.equal(stemmer.stem('programming'), 'program');
}

function testMixed() {
  let doit = str => [...stemmer.tokenizeAndStem(str)];

  assert.deepEqual(doit('Test'), ['test']);
  assert.deepEqual(doit('No stop signs, speed limit'), ['stop', 'sign', 'speed', 'limit']);
  assert.deepEqual(doit('Простой instance'), ['прост', 'instanc'])
  assert.deepEqual(doit('Test 10words  Слово'), ['test', 'word', 'слов']);
  assert.deepEqual(doit('Test10words'), ['test', 'word']);
  assert.deepEqual(doit(' Test10words\n'), ['test', 'word']);
  assert.deepEqual(doit(' Test10words\n\n  100пример\n'), ['test', 'word', 'пример']);
  assert.deepEqual(doit('1In 20the \u1232middle of\r\ra railroad%track'),
                        ['middl', 'railroad', 'track']);
}

function testKinks() {
  assert.equal(stemmer.stem(null), undefined);
  assert.equal(stemmer.stem(''), undefined);
  assert.equal(stemmer.stem('b'.repeat(100)), undefined);
  assert.equal(stemmer.stem('б'.repeat(100)), undefined);
  assert.equal(stemmer.stem(' b'), undefined);
  assert.equal(stemmer.stem('100'), undefined);
  assert.equal(stemmer.stem('the'), undefined);
}

testStem();
testMixed();
testKinks();
