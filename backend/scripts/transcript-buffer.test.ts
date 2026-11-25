import { describe, it, expect } from 'vitest';
import { TranscriptBuffer } from '../src/transcript-buffer.js';
const s='00000000-0000-4000-8000-000000000001', a='00000000-0000-4000-8000-000000000002', b='00000000-0000-4000-8000-000000000003', id='00000000-0000-4000-8000-000000000004';
const line={segmentId:id,revision:0,startMs:10,endMs:20,text:'hello',isFinal:false};
describe('Member 4 canonical transcript',()=>{
  it('attributes two tracks and rejects forged identity',()=>{const c=new TranscriptBuffer(s,[a,b],1000);try{const one=c.bindTrack('TR_one',a)!,two=c.bindTrack('TR_two',b)!;expect(one(line)?.participantId).toBe(a);expect(two({...line,segmentId:s})?.participantId).toBe(b);expect(two({...line,participantId:a})).toBeNull();expect(c.captureComplete).toBe(false);}finally{c.purge();}});
  it('revises provisional text, ignores replay and protects final',()=>{const c=new TranscriptBuffer(s,[a,b],1000);try{const add=c.bindTrack('TR_one',a)!;add(line);expect(add(line)).toBeNull();expect(add({...line,revision:1,text:'final',isFinal:true})?.isFinal).toBe(true);expect(add({...line,revision:2})).toBeNull();expect(c.snapshot(a)![0].text).toBe('final');}finally{c.purge();}});
  it('isolates snapshots and rejects nonmembers',()=>{const c=new TranscriptBuffer(s,[a,b],1000);try{c.bindTrack('TR_one',a)!(line);expect(c.snapshot(s)).toBeNull();c.snapshot(a)![0].text='forged';expect(c.snapshot(b)![0].text).toBe('hello');}finally{c.purge();}});
  it('bounds UTF-8 bytes and metadata',()=>{const c=new TranscriptBuffer(s,[a,b],1000,6,1);try{const add=c.bindTrack('TR_one',a)!;expect(add({...line,text:'你好'})).not.toBeNull();expect(add({...line,revision:1,text:'你好啊'})).toBeNull();expect(add({...line,segmentId:s,text:'x'})).toBeNull();expect(c.captureComplete).toBe(false);}finally{c.purge();}});
  it('rejects invalid ranges and clears on purge',()=>{const c=new TranscriptBuffer(s,[a,b],1000);const add=c.bindTrack('TR_one',a)!;expect(add({...line,endMs:1001})).toBeNull();add(line);c.purge();expect(add({...line,revision:1})).toBeNull();expect(c.snapshot(a)).toBeNull();expect(c.evaluationInput()).toBeNull();});
  it('blocks cross-track segment takeover and marks a disconnect gap',()=>{const c=new TranscriptBuffer(s,[a,b],1000);try{c.bindTrack('TR_one',a)!(line);expect(c.bindTrack('TR_two',b)!({...line,revision:1})).toBeNull();c.unbindTrack('TR_one');expect(c.captureComplete).toBe(false);}finally{c.purge();}});
  it('requires complete, frozen capture and sufficient final speech from both speakers', () => {
    const c = new TranscriptBuffer(s, [a, b], 1000);
    try {
      const one = c.bindTrack('TR_one', a)!;
      const two = c.bindTrack('TR_two', b)!;
      const text = 'word '.repeat(50).trim();
      one({ ...line, text, isFinal: true });
      two({ ...line, segmentId: s, text, isFinal: true });
      expect(c.evaluationInput()).toBeNull();
      c.freeze();
      expect(c.evaluationInput()?.map(segment => segment.participantId).sort()).toEqual([a, b]);
      expect(one({ ...line, segmentId: b })).toBeNull();
      c.markGap();
      expect(c.evaluationInput()).toBeNull();
    } finally { c.purge(); }
  });
  it('invalidates old callbacks and protects segments from another track of the same owner', () => {
    const c = new TranscriptBuffer(s, [a, b], 1000);
    try {
      const old = c.bindTrack('TR_one', a)!;
      old(line);
      c.unbindTrack('TR_one', true);
      c.bindTrack('TR_one', a);
      expect(old({ ...line, revision: 1 })).toBeNull();
      expect(c.bindTrack('TR_two', a)!({ ...line, revision: 1 })).toBeNull();
      expect(c.snapshot(a)![0].revision).toBe(0);
    } finally { c.purge(); }
  });
});
