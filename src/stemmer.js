"use strict";

import natural from 'natural';

import {words as enStopwords} from 'natural/lib/natural/util/stopwords';
import {words as ruStopwords} from 'natural/lib/natural/util/stopwords_ru';


const stopwords = new Set(enStopwords.concat(ruStopwords, `
  about above abroad according accordingly across actually adj after afterwards again against ago
  ahead ain all allow allows almost alone along alongside already also although always am amid
  amidst among amongst an and another any anybody anyhow anyone anything anyway anyways anywhere
  apart appear appreciate appropriate are aren around as aside ask asking associated at available
  away awfully back backward backwards be became because become becomes becoming been before
  beforehand begin behind being believe below beside besides best better between beyond both brief
  but by came can cannot cant caption cause causes certain certainly changes clearly co com come
  comes concerning consequently consider considering contain containing contains corresponding
  could couldn course currently dare daren definitely described despite did didn different directly
  do does doesn doing don done down downwards during each edu eg eight eighty either else elsewhere
  end ending enough entirely especially et etc even ever evermore every everybody everyone
  everything everywhere ex exactly example except fairly far farther few fewer fifth first five
  followed following follows for forever former formerly forth forward found four from further
  furthermore get gets getting given gives go goes going gone got gotten greetings had hadn half
  happens hardly has hasn have haven having he hello help hence her here hereafter hereby herein
  hereupon hers herself hi him himself his hither hopefully how howbeit however hundred ie if
  ignored immediate in inasmuch inc indeed indicate indicated indicates inner inside insofar
  instead into inward is isn it its itself just keep keeps kept know known knows last lately later
  latter latterly least less lest let like liked likely likewise little ll look looking looks low
  lower ltd made mainly make makes many may maybe mayn me mean meantime meanwhile merely might
  mightn mine minus miss more moreover most mostly mr mrs much must mustn my myself name namely
  nd near nearly necessary need needn needs neither never neverf neverless nevertheless new next
  nine ninety no no-one nobody non none nonetheless noone nor normally not nothing notwithstanding
  novel now nowhere obviously of off often oh ok okay old on once one ones only onto opposite or
  other others otherwise ought oughtn our ours ourselves out outside over overall own particular
  particularly past per perhaps placed please plus possible presumably probably provided provides
  que quite qv rather rd re really reasonably recent recently regarding regardless regards
  relatively respectively right round said same saw say saying says second secondly see seeing seem
  seemed seeming seems seen self selves sensible sent serious seriously seven several shall shan
  she should shouldn since six so some somebody someday somehow someone something sometime
  sometimes somewhat somewhere soon sorry specified specify specifying still sub such sup sure take
  taken taking tell tends th than thank thanks thanx that thats the their theirs them themselves
  then thence there thereafter thereby therefore therein theres thereupon these they thing things
  think third thirty this thorough thoroughly those though three through throughout thru thus till
  to together too took toward towards tried tries truly try trying twice two un under underneath
  undoing unfortunately unless unlike unlikely until unto up upon upwards us use used useful uses
  using usually value various versus very via viz vs want wants was wasn way we welcome well went
  were weren what whatever when whence whenever where whereafter whereas whereby wherein whereupon
  wherever whether which whichever while whilst whither who whoever whole whom whomever whose why
  will willing wish with within without won wonder would wouldn yes yet you your yours yourself
  yourselves zero
  без более бы был была были было быть вам вас вдоль ведь весь вместо вне вниз внизу внутри во
  вокруг вот все всегда всего всех вы где да давай давать даже для до достаточно его ее если есть
  ещё её же за здесь из из-за или им иметь исключением их как как-то когда кроме кто ли либо мне
  может мои мой мы на навсегда над надо наш не него нет неё ни них но ну об однако он она они оно
  от отчего очень по под после потому почти при про снова со так также такие такой там те тем то
  того тоже той только том тут ты уже хотя чего чего-то чей чем что чтобы чья чьё эта эти это
`.split(/\s+/)));

const reTrash = /[^a-zа-яё]+/i;


export default class Stemmer {
  constructor() {
    this.enStemmer = natural.PorterStemmer;
    this.ruStemmer = natural.PorterStemmerRu;
  }

  *tokenizeAndStem(text) {
    let words = text.split(reTrash);

    for (let word of words) {
      let stem = this.stem(word);
      if (stem)
        yield stem;
    }
  }

  stem(word) {
    if (!word) return;

    word = word.toLowerCase();

    if (!stopwords.has(word) && word.length <= 20 && word[0] >= 'a') {
      let stemmer = word[0] <= 'z' ? this.enStemmer : this.ruStemmer;
      return stemmer.stem(word);
    }
  }
}
