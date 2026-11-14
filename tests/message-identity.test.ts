import test from 'node:test';
import assert from 'node:assert/strict';
import {groupMessageParticipant} from '../src/whatsapp/message-identity.ts';

test('prefers the primary group participant identity when available',()=>{
 assert.equal(groupMessageParticipant({participant:'5511999999999@s.whatsapp.net',participantAlt:'1234567890@lid'}),'5511999999999@s.whatsapp.net');
});

test('falls back to participantAlt when WhatsApp omits participant',()=>{
 assert.equal(groupMessageParticipant({participant:undefined,participantAlt:'1234567890@lid'}),'1234567890@lid');
});

test('returns undefined when neither sender identity is present',()=>{
 assert.equal(groupMessageParticipant({}),undefined);
});
