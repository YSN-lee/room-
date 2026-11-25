import { describe, it, expect } from 'vitest';
import { TranscriptBuffer, type Segment } from '../src/transcript-buffer.js';
import { TranscriptionAdapter } from '../src/transcription-adapter.js';
const s='00000000-0000-4000-8000-000000000001', a='00000000-0000-4000-8000-000000000002', b='00000000-0000-4000-8000-000000000003';
async function* frames() { yield new Uint8Array([0,0]); }
describe('Member 4 adapter core',()=>{
  it('routes independent audio streams to separate recognizers with verified attribution',async()=>{
    const buffer=new TranscriptBuffer(s,[a,b],1000); const output: Segment[]=[]; let count=0;
    const adapter=new TranscriptionAdapter(buffer,async receive=>{const id=++count;return {write:async()=>receive({segmentId:id===1?a:b,revision:0,startMs:0,endMs:10,text:'fixture '+id,isFinal:true}),close:async()=>{}};},segment=>output.push(segment));
    try { await Promise.all([adapter.consume({trackId:'TR_a',ownerIdentity:a,source:'microphone',frames:frames()}),adapter.consume({trackId:'TR_b',ownerIdentity:b,source:'microphone',frames:frames()})]); expect(count).toBe(2);expect(output.map(x=>x.participantId).sort()).toEqual([a,b]);expect(buffer.finalized().length).toBe(2); } finally {adapter.stop();}
  });
  it('does not open a recognizer for nonmembers or nonmicrophone tracks',async()=>{const buffer=new TranscriptBuffer(s,[a,b],1000);let count=0;const adapter=new TranscriptionAdapter(buffer,async()=>{count++;return {write:async()=>{},close:async()=>{}};},()=>{});try{await adapter.consume({trackId:'TR_bad',ownerIdentity:s,source:'microphone',frames:frames()});await adapter.consume({trackId:'TR_screen',ownerIdentity:a,source:'other',frames:frames()});expect(count).toBe(0);expect(buffer.captureComplete).toBe(false);}finally{adapter.stop();}});
  it('marks provider failure and clears temporary data on stop',async()=>{const buffer=new TranscriptBuffer(s,[a,b],1000);const adapter=new TranscriptionAdapter(buffer,async()=>{throw new Error('fixture outage');},()=>{});await adapter.consume({trackId:'TR_a',ownerIdentity:a,source:'microphone',frames:frames()});expect(buffer.captureComplete).toBe(false);adapter.stop();expect(buffer.snapshot(a)).toBeNull();});
});
