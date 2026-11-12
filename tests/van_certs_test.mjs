// node tests/van_certs_test.mjs — Amazon van certification rules (Jose 2026-11-11): EDV covers CDV.
import assert from 'node:assert/strict';
import { canDrive, certIndex, certLabel } from '../public/app/lib/van-certs.js';

assert.equal(canDrive('EDV', 'EDV'), true);
assert.equal(canDrive('EDV', 'CDV'), true, 'EDV covers CDV');
assert.equal(canDrive('CDV', 'CDV'), true);
assert.equal(canDrive('CDV', 'EDV'), false);
assert.equal(canDrive('', 'CDV'), false);
assert.equal(canDrive(null, 'EDV'), false);
assert.equal(canDrive('', ''), true, 'any van needs nothing');
assert.equal(certLabel('EDV'), 'EDV + CDV');

const look = certIndex({
  'Mark Christian Barker': { tid: 'AIJ8GCPWCPV4O', cert: 'EDV' },
  'Ryan Anthony Talbert': { tid: 'A2YUNLWXFQHE4P', cert: 'CDV' },
  'Donald Gene nay': { tid: 'A27EXHKWPGB868', cert: '' },
  'Pat Old': { tid: 'T1' },                                    // before the cloud wrote certs
  'Sam A Lee': { tid: 'T2', cert: 'EDV' }, 'Sam B Lee': { tid: 'T3', cert: 'CDV' },
});
assert.equal(look('anything', 'AIJ8GCPWCPV4O'), 'EDV', 'Transporter ID first');
assert.equal(look('Ryan  anthony TALBERT'), 'CDV', 'exact name, case and spaces folded');
assert.equal(look('Ryan Talbert'), 'CDV', 'first|last when only one person has it');
assert.equal(look('Donald Gene Nay'), '');
assert.equal(look('Pat Old'), '');
assert.equal(look('Sam Lee'), null, 'two people share first|last with different certs: no guess');
assert.equal(look('Nobody Here'), null);
console.log('van_certs_test: ok');
