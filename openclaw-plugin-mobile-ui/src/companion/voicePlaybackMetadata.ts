/** Additive metadata in the existing conversation record; never an audio store. */
export type VoicePlaybackMetadata={version:1;outputGenerationId:string;generationState:"generating"|"completed"|"interrupted";
  state:"not_started"|"playing"|"completed"|"interrupted"|"unknown";receivedFrames:number;writtenFrames:number;playedFrames:number;sampleRate:24000;clock:"audio_track_head"};
export function validateVoicePlayback(value:any):VoicePlaybackMetadata|undefined {
  if(value===undefined)return undefined;
  const keys=new Set(["version","outputGenerationId","generationState","state","receivedFrames","writtenFrames","playedFrames","sampleRate","clock"]);
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(k=>!keys.has(k))||value.version!==1||
    !/^[A-Za-z0-9._:-]{1,180}$/.test(value.outputGenerationId||"")||value.sampleRate!==24000||value.clock!=="audio_track_head"||
    !["generating","completed","interrupted"].includes(value.generationState)||
    !["not_started","playing","completed","interrupted","unknown"].includes(value.state)||
    ![value.receivedFrames,value.writtenFrames,value.playedFrames].every(v=>Number.isSafeInteger(v)&&v>=0&&v<=2_073_600_000)||
    value.playedFrames>value.writtenFrames||value.writtenFrames>value.receivedFrames||
    (value.state==="completed"&&(value.generationState!=="completed"||value.playedFrames!==value.receivedFrames)))
    throw Object.assign(new Error("invalid_voice_playback"),{statusCode:400});
  return {...value};
}
