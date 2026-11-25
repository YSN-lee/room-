import { useEffect, useState } from 'react';
import { subscribeTranscript } from './liveTranscript';
import { TranscriptPanel } from './TranscriptPanel';
import type { RoomParticipant, TranscriptSegment } from './types';

export function LiveTranscript({ sessionId, accessToken, participants }: {
  sessionId: string;
  accessToken: string;
  participants: RoomParticipant[];
}) {
  const [view, setView] = useState<{ segments: TranscriptSegment[]; degraded: boolean } | null>(null);
  useEffect(() => {
    setView(null);
    return subscribeTranscript(sessionId, accessToken, setView);
  }, [sessionId, accessToken]);

  return view ? <TranscriptPanel {...view} participants={participants} /> : null;
}
