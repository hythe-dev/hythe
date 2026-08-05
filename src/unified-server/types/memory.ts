// Hierarchical Memory System Types
export interface MemorySystem {
  individual: Map<string, IndividualMemory>;
  shared: SharedMemory;
}

export interface IndividualMemory {
  agentId: string;
  preferences: AgentPreferences;
  learnings: LearningHistory[];
  privateContext: PrivateMemory[];
  capabilities: AgentCapability[];
}

export interface SharedMemory {
  project: ProjectContext;
  tasks: TaskGraph;
  decisions: ConsensusHistory[];
  knowledge: SharedKnowledge[];
  artifacts: ProjectArtifacts[];
}

// Individual Memory Components
export interface AgentPreferences {
  workingStyle: string;
  communicationStyle: string;
  toolPreferences: string[];
  learningRate: number;
  customSettings: { [key: string]: any };
}

export interface LearningHistory {
  id: string;
  timestamp: Date;
  context: string;
  lesson: string;
  confidence: number;
  reinforcements: number;
}

export interface PrivateMemory {
  id: string;
  type: 'note' | 'insight' | 'reminder' | 'plan';
  content: string;
  tags: string[];
  importance: number;
  expiresAt?: Date;
  createdAt: Date;
}

export interface AgentCapability {
  name: string;
  description: string;
  proficiency: number; // 0-1 scale
  lastUsed: Date;
  successRate: number;
  parameters: any;
}

// Shared Memory Components
export interface ProjectContext {
  id: string;
  name: string;
  description: string;
  goals: string[];
  constraints: string[];
  timeline: ProjectTimeline;
  stakeholders: string[];
  status: 'planning' | 'active' | 'on-hold' | 'completed';
}

export interface ProjectTimeline {
  startDate: Date;
  endDate?: Date;
  milestones: Milestone[];
  criticalPath: string[];
}

export interface Milestone {
  id: string;
  name: string;
  description: string;
  targetDate: Date;
  dependencies: string[];
  status: 'pending' | 'in-progress' | 'completed' | 'blocked';
}

export interface TaskGraph {
  tasks: Map<string, Task>;
  dependencies: Map<string, string[]>;
  assignments: Map<string, string>; // taskId -> agentId
}

export interface Task {
  id: string;
  title: string;
  description: string;
  requirements: TaskRequirements;
  status: TaskStatus;
  priority: 'low' | 'medium' | 'high' | 'critical';
  estimatedEffort: number; // hours
  actualEffort?: number;
  createdBy: string;
  assignedTo?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date | undefined;
  parentTaskId?: string | undefined;
  childTaskIds: string[];
}

export enum TaskStatus {
  CREATED = 'created',
  ASSIGNED = 'assigned',
  IN_PROGRESS = 'in_progress',
  BLOCKED = 'blocked',
  REVIEW = 'review',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled'
}

export interface TaskRequirements {
  skills: string[];
  tools: string[];
  dependencies: string[];
  deliverables: Deliverable[];
  acceptanceCriteria: string[];
  constraints?: any;
}

export interface Deliverable {
  name: string;
  description: string;
  type: 'file' | 'data' | 'decision' | 'artifact';
  format?: string;
  quality: QualityRequirement[];
}

export interface QualityRequirement {
  metric: string;
  threshold: number;
  critical: boolean;
}

export interface ConsensusHistory {
  id: string;
  decision: string;
  participants: string[];
  votes: Map<string, Vote>;
  result: ConsensusResult;
  reasoning: string;
  createdAt: Date;
  resolvedAt?: Date | undefined;
}

export interface Vote {
  agentId: string;
  choice: string;
  reasoning?: string | undefined;
  confidence: number;
  timestamp: Date;
}

export interface ConsensusResult {
  status: 'reached' | 'failed' | 'timeout';
  finalDecision?: string;
  supportLevel: number; // 0-1 percentage
  dissenting?: string[];
}

export interface SharedKnowledge {
  id: string;
  title: string;
  content: string;
  type: 'fact' | 'pattern' | 'best-practice' | 'lesson-learned';
  tags: string[];
  source: string; // agentId or 'human'
  confidence: number;
  verifications: Verification[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Verification {
  agentId: string;
  verified: boolean;
  notes?: string;
  timestamp: Date;
}

export interface ProjectArtifacts {
  id: string;
  name: string;
  type: 'code' | 'document' | 'data' | 'model' | 'config';
  path: string;
  version: string;
  createdBy: string;
  modifiedBy: string;
  size: number;
  checksum: string;
  metadata: ArtifactMetadata;
  createdAt: Date;
  modifiedAt: Date;
}

export interface ArtifactMetadata {
  language?: string;
  framework?: string;
  dependencies?: string[];
  documentation?: string;
  tags: string[];
  customData: { [key: string]: any };
}

// Memory Operations
export interface MemoryQuery {
  type?: 'individual' | 'shared' | 'all';
  agentId?: string;
  tags?: string[];
  content?: string;
  timeRange?: {
    start: Date;
    end: Date;
  };
  importance?: {
    min: number;
    max: number;
  };
  limit?: number;
}

export interface MemoryScope {
  individual?: boolean;
  shared?: boolean;
  agentIds?: string[];
}

export interface SearchResult {
  id: string;
  type: 'individual' | 'shared';
  content: any;
  relevance: number;
  source: string;
  timestamp: Date;
  memoryType?: string;
  chunked?: boolean;
  contentSize?: number;
  totalChunks?: number;
  chunkSize?: number;
  /** Raw vec0 distance for semantic hits (lower = closer). */
  distance?: number;
  /** Bounded 0..1 semantic similarity derived from distance. */
  semanticSimilarity?: number;
}

export interface MemoryUpdate {
  type: 'individual' | 'shared';
  operation: 'create' | 'update' | 'delete' | 'share';
  path: string;
  data: any;
  agentId: string;
  timestamp: Date;
}
