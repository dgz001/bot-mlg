// WhatsApp may expose a group sender as participantAlt when its primary
// participant field is absent (for example, LID-based identities).
export function groupMessageParticipant(key:{participant?:string|null;participantAlt?:string|null}):string|undefined{
 return key.participant??key.participantAlt??undefined;
}
