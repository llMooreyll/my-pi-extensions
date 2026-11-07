export type UiRequest =
  | { uiId: string; kind: "select"; title: string; options: string[]; timeoutMs?: number }
  | { uiId: string; kind: "confirm"; title: string; message: string; timeoutMs?: number }
  | { uiId: string; kind: "input"; title: string; placeholder?: string; timeoutMs?: number }
  | { uiId: string; kind: "editor"; title: string; prefill?: string }
  | { uiId: string; kind: "custom"; title?: string; coveredBy?: string };

export type UiResponse =
  | { value: string }          // select / input / editor
  | { confirmed: boolean }     // confirm
  | { cancelled: true };       // 任意类型；custom 只接受这一种

export interface RpivOption { label: string; description?: string; hasPreview?: boolean }
export interface RpivQuestion { question: string; header: string; multiSelect: boolean; options: RpivOption[] }
export interface RpivPrompt { toolCallId: string; questions: RpivQuestion[] }

export interface RpivAnswerItem {
  questionIndex: number;
  optionIndexes?: number[];
  text?: string;
}
export interface RpivAnswer {
  toolCallId: string;
  answers?: RpivAnswerItem[];
  globalNote?: string;
  cancel?: true;
}
