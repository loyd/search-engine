import natural from 'natural';

import {words as enStopwords} from 'natural/lib/natural/util/stopwords';
import {words as ruStopwords} from 'natural/lib/natural/util/stopwords_ru';


const stopwords = new Set(enStopwords.concat(ruStopwords));

export default class Stemmer {
  constructor() {
    this.enStemmer = natural.PorterStemmer;
    this.ruStemmer = natural.PorterStemmerRu;
  }

  *tokenizeAndStem(text) {
    let words = this.clear(text).split(' ');

    for (let word of words) {
      let stem = this.stem(word);
      if (stem)
        yield stem;
    }
  }

  clear(text) {
    return text.replace(/[^a-zа-яё]/gi, ' ').replace(/[\s\n]+/g, ' ').trim();
  }

  stem(word) {
    if (!word) return;

    word = word.toLowerCase();

    if (!stopwords.has(word) && word.length < 50 && word[0] >= 'a') {
      let stemmer = word[0] <= 'z' ? this.enStemmer : this.ruStemmer;
      return stemmer.stem(word);
    }
  }
}
