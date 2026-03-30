const notPrecededByDigitDollarDash = '(?<![0-9$\\-])';
const notFollowedByDotDashDigit = '(?![.\\-0-9])';
const cptBody = '\\b([0-9]{5}|[JGABC][0-9]{4})\\b';
const CPT_PATTERN = new RegExp(notPrecededByDigitDollarDash + cptBody + notFollowedByDotDashDigit, 'g');

const tests = [
  ['VGH-2024-98741', 'should NOT match 98741'],
  ['$55000.00', 'should NOT match 55000'],
  ['$15000.00', 'should NOT match 15000'],
  ['J0696', 'SHOULD match J0696'],
  ['J9035', 'SHOULD match J9035'],
  ['99285', 'SHOULD match 99285'],
  ['99285 ECG 93010', 'SHOULD match 99285, 93010'],
  ['J0696 Ceftriaxone $150.00', 'SHOULD match J0696'],
  ['36415 Blood Collection $25.00  J0696 Ceftriaxone', 'SHOULD match 36415, J0696'],
  ['2024-98741', 'should NOT match 98741'],
  ['x40 units $55000.00', 'should NOT match 55000'],
];

for (const [text, desc] of tests) {
  CPT_PATTERN.lastIndex = 0;
  const matches = [...text.matchAll(CPT_PATTERN)].map(m => m[0]);
  console.log(desc + ': ' + JSON.stringify(matches));
}
