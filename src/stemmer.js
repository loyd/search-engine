import natural from 'natural';

import {words as enStopwords} from 'natural/lib/natural/util/stopwords';
import {words as ruStopwords} from 'natural/lib/natural/util/stopwords_ru';


const stopwords = new Set(enStopwords.concat(ruStopwords));

export default class Stemmer {
  constructor() {
    this.tokenizer = new natural.AggressiveTokenizerRu;
    this.enStemmer = natural.PorterStemmer;
    this.ruStemmer = natural.PorterStemmerRu;
  }

  tokenizeAndStem(text, limit=Infinity) {
    let words = this.tokenizer.tokenize(text);
    let stemmed = [];

    for (let word of words) {
      word = word.toLowerCase();

      if (!stopwords.has(word) && word.length < 50) {
        let stemmer = word.charCodeAt(0) < 128 ? this.enStemmer : this.ruStemmer;
        stemmed.push(stemmer.stem(word));

        if (stemmed.length >= limit)
          break;
      }
    }

    return stemmed;
  }
}
