export type AvatarMood =
  | 'neutral'
  | 'happy'
  | 'sad'
  | 'angry'
  | 'relaxed'
  | 'surprised'
  | 'thinking';

export type AvatarState =
  | 'idle'
  | 'enter'
  | 'exit'
  | 'talk'
  | 'listen'
  | 'think'
  | 'celebrate'
  | 'sad';

export interface LinkSet {
  github?: string;
  linkedin?: string;
  portfolio?: string;
  leetcode?: string;
  other?: string[];
}

export interface Identity {
  fullName: string;
  firstName?: string;
  lastName?: string;
  dob?: string;
  gender?: string;
  phone?: string;
  email?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  links: LinkSet;
}

export interface Education {
  institution: string;
  degree?: string;
  field?: string;
  startYear?: string;
  endYear?: string;
  grade?: string;
}

export interface Experience {
  company: string;
  role?: string;
  startDate?: string;
  endDate?: string;
  current?: boolean;
  location?: string;
  description?: string;
}

export interface Project {
  name: string;
  description?: string;
  url?: string;
  tech?: string[];
}

export interface DocumentRef {
  id: string;
  name: string;
  mime: string;
  size?: number;
  dataUrl?: string;
}

export interface Preferences {
  roles?: string[];
  locations?: string[];
  workType?: 'remote' | 'hybrid' | 'onsite' | 'any';
  noticePeriod?: string;
  expectedCtc?: string;
}

export interface CustomAnswer {
  pattern: string;
  answer: string;
}

export interface Secrets {
  govIds?: Record<string, string>;
  pan?: string;
  bank?: Record<string, string>;
}

export interface Profile {
  identity: Identity;
  education: Education[];
  experience: Experience[];
  skills: string[];
  projects: Project[];
  certifications?: string[];
  documents: Record<string, DocumentRef>;
  customAnswers: CustomAnswer[];
  preferences: Preferences;
  secrets: Secrets;
}

export type ReminderStatus = 'pending' | 'done' | 'snoozed';

export interface Reminder {
  id: string;
  title: string;
  notes?: string;
  dueAt: string;
  status: ReminderStatus;
  createdAt: string;
  source?: string;
}

export type OpportunityKind = 'job' | 'internship' | 'scholarship' | 'event' | 'other';

export interface Opportunity {
  id: string;
  title: string;
  company?: string;
  url?: string;
  deadline?: string;
  kind?: OpportunityKind;
  foundAt: string;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type ToolName =
  | 'readPage'
  | 'fillForm'
  | 'getProfile'
  | 'createReminder'
  | 'listReminders'
  | 'crawl'
  | 'searchWeb'
  | 'readInbox'
  | 'readCalendar'
  | 'notify'
  | 'speak'
  | 'setMood'
  | 'playAnim';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  toolName?: ToolName;
}

export interface FieldDescriptor {
  id: string;
  tag: 'input' | 'textarea' | 'select';
  type?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  ariaLabel?: string;
  required?: boolean;
  options?: string[];
}

export interface FillInstruction {
  fieldId: string;
  value: string;
  confidence?: number;
  profilePath?: string;
}

export interface PageContext {
  url: string;
  title: string;
  text: string;
  fields?: FieldDescriptor[];
}
