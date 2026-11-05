export const claudeResponseLanguagePresets = [
  ['af', 'Afrikaans'], ['sq', 'Albanian'], ['am', 'Amharic'], ['ar', 'Arabic'],
  ['hy', 'Armenian'], ['as', 'Assamese'], ['az', 'Azerbaijani'], ['eu', 'Basque'],
  ['be', 'Belarusian'], ['bn', 'Bengali'], ['bs', 'Bosnian'], ['bg', 'Bulgarian'],
  ['my', 'Burmese'], ['ca', 'Catalan'], ['ceb', 'Cebuano'],
  ['zh-Hans', 'Simplified Chinese'], ['zh-Hant', 'Traditional Chinese'],
  ['hr', 'Croatian'], ['cs', 'Czech'], ['da', 'Danish'], ['nl', 'Dutch'],
  ['en', 'English'], ['eo', 'Esperanto'], ['et', 'Estonian'], ['fil', 'Filipino'],
  ['fi', 'Finnish'], ['fr', 'French'], ['gl', 'Galician'], ['ka', 'Georgian'],
  ['de', 'German'], ['el', 'Greek'], ['gu', 'Gujarati'], ['ht', 'Haitian Creole'],
  ['ha', 'Hausa'], ['he', 'Hebrew'], ['hi', 'Hindi'], ['hu', 'Hungarian'],
  ['is', 'Icelandic'], ['ig', 'Igbo'], ['id', 'Indonesian'], ['ga', 'Irish'],
  ['it', 'Italian'], ['ja', 'Japanese'], ['jv', 'Javanese'], ['kn', 'Kannada'],
  ['kk', 'Kazakh'], ['km', 'Khmer'], ['ko', 'Korean'], ['ku', 'Kurdish'],
  ['ky', 'Kyrgyz'], ['lo', 'Lao'], ['la', 'Latin'], ['lv', 'Latvian'],
  ['lt', 'Lithuanian'], ['lb', 'Luxembourgish'], ['mk', 'Macedonian'],
  ['mg', 'Malagasy'], ['ms', 'Malay'], ['ml', 'Malayalam'], ['mt', 'Maltese'],
  ['mi', 'Māori'], ['mr', 'Marathi'], ['mn', 'Mongolian'], ['ne', 'Nepali'],
  ['no', 'Norwegian'], ['ny', 'Nyanja'], ['or', 'Odia'], ['ps', 'Pashto'],
  ['fa', 'Persian'], ['pl', 'Polish'], ['pt', 'Portuguese'], ['pa', 'Punjabi'],
  ['ro', 'Romanian'], ['ru', 'Russian'], ['sm', 'Samoan'], ['sa', 'Sanskrit'],
  ['gd', 'Scottish Gaelic'], ['sr', 'Serbian'], ['sn', 'Shona'], ['sd', 'Sindhi'],
  ['si', 'Sinhala'], ['sk', 'Slovak'], ['sl', 'Slovenian'], ['so', 'Somali'],
  ['es', 'Spanish'], ['su', 'Sundanese'], ['sw', 'Swahili'], ['sv', 'Swedish'],
  ['tg', 'Tajik'], ['ta', 'Tamil'], ['tt', 'Tatar'], ['te', 'Telugu'],
  ['th', 'Thai'], ['bo', 'Tibetan'], ['tr', 'Turkish'], ['tk', 'Turkmen'],
  ['uk', 'Ukrainian'], ['ur', 'Urdu'], ['ug', 'Uyghur'], ['uz', 'Uzbek'],
  ['vi', 'Vietnamese'], ['cy', 'Welsh'], ['xh', 'Xhosa'], ['yi', 'Yiddish'],
  ['yo', 'Yoruba'], ['zu', 'Zulu'],
] as const;

export function claudeResponseLanguageOptions(locale: string) {
  const names = new Intl.DisplayNames([locale], { type: 'language' });
  return claudeResponseLanguagePresets.map(([code, value]) => ({
    value,
    label: names.of(code) ?? value,
  })).sort((left, right) => left.label.localeCompare(right.label, locale));
}

export function claudeResponseLanguageMode(value: string | null | undefined) {
  if (value == null) return 'unmanaged';
  if (value === '') return 'default';
  return claudeResponseLanguagePresets.some(([, preset]) => preset === value) ? value : 'custom';
}
