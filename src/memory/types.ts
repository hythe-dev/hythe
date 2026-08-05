export type MemoryType = 'task' | 'knowledge' | 'episodic' | 'semantic' | 'working' | 'long_term';

export interface MemoryItem {
  id: string;
  agentId: string;
  tenantId?: string; // Multi-tenant isolation (Phase 5)
  type: MemoryType;
  content: string;
  timestamp: number; // Changed from Date to number to match usage
  tags: string[];
  priority: number;
  relationships: string[];
  embedding?: number[];
  metadata?: Record<string, any>;
}

export interface AgentMemory {
  agentId: string;
  memories: MemoryItem[];
  profile: AgentProfile;
  statistics: MemoryStatistics;
}

export interface AgentProfile {
  id: string;
  name: string;
  capabilities: string[];
  preferences: Record<string, any>;
  lastActive: number; // Changed from Date to number
  memoryCapacity: number;
}

export interface MemoryStatistics {
  total: number;
  byType: Record<MemoryType, number>;
  byPriority: Record<number, number>;
  recentActivity: number;
  averagePriority: number;
}

export interface Relationship {
  id: string;
  fromMemoryId: string;
  toMemoryId: string;
  type: string;
  strength: number;
  properties: Record<string, any>;
  timestamp: number; // Changed from Date to number
}

export interface MemorySearchQuery {
  query: string;
  agentId?: string;
  tenantId?: string; // Multi-tenant isolation (Phase 5)
  memoryType?: MemoryType;
  tags?: string[];
  dateRange?: {
    start: number; // Changed from Date to number
    end: number; // Changed from Date to number
  };
  priority?: {
    min: number;
    max: number;
  };
  limit: number;
  offset: number;
}

export interface MemorySearchResult {
  memories: MemoryItem[];
  total: number;
  query: string;
  searchTime: number;
  relevance: number[];
}

export interface HierarchicalMemory {
  working: MemoryItem[];
  shortTerm: MemoryItem[];
  longTerm: MemoryItem[];
  episodic: MemoryItem[];
  semantic: MemoryItem[];
}

export interface MemoryConsolidationResult {
  consolidated: MemoryItem[];
  removed: string[];
  merged: string[][];
  newRelationships: Relationship[];
}

export interface VectorSearchResult {
  id: string;
  content: string;
  similarity: number;
  metadata: Record<string, any>;
}

export interface GraphQueryResult {
  nodes: Array<{
    id: string;
    type: string;
    properties: Record<string, any>;
  }>;
  relationships: Array<{
    id: string;
    type: string;
    startNode: string;
    endNode: string;
    properties: Record<string, any>;
  }>;
}

export interface MemorySystemConfig {
  vectorDatabase: {
    type: 'weaviate' | 'sqlite-vec';
    host: string;
    port: number;
    apiKey?: string;
  };
  graphDatabase: {
    type: 'neo4j';
    host: string;
    port: number;
    username: string;
    password: string;
  };
  cache: {
    type: 'redis';
    host: string;
    port: number;
    ttl: number;
  };
  consolidation: {
    enabled: boolean;
    interval: number;
    threshold: number;
  };
  embedding: {
    model: string;
    dimensions: number;
    batchSize: number;
  };
}

// Neural AI Platform Types
export interface MemoryImportance {
  memoryId: string;
  importance: number;
  factors: string[];
  confidence: number;
}

export interface NeuralPattern {
  id: string;
  type: 'memory' | 'behavior' | 'collaboration' | 'performance' | 'temporal_cluster' | 'semantic_cluster' | 'agent_interaction';
  pattern: string;
  confidence: number;
  associatedMemoryIds: string[];
  metadata: Record<string, any>;
}

export interface LearningPattern {
  id: string;
  type: 'adaptive_learning' | 'behavior_pattern' | 'collaboration_pattern';
  featureVector: number[];
  confidence: number;
  occurrenceCount: number;
  lastSeen: number;
  associatedMemoryIds: string[];
  metadata: Record<string, any>;
  agentId?: string;
  pattern?: string;
  successRate?: number;
  frequency?: number;
  lastUsed?: number;
}

export interface PredictionResult {
  id: string;
  patternId?: string;
  confidence: number;
  predictedType?: string;
  predictedAgent?: string;
  predictedTiming?: number;
  context?: {
    memoryId: string;
    agentId: string;
    timestamp: number;
  };
  metadata?: Record<string, any>;
  type: 'task_assignment' | 'resource_allocation' | 'collaboration_optimization';
  prediction: string;
  reasoning: string[];
  timestamp: number; // Changed from Date to number
}

export interface CollaborationInsight {
  id: string;
  type: 'problem_solving' | 'knowledge_sharing' | 'coordination';
  insight: string;
  confidence: number;
  affectedAgents: string[];
  recommendations: string[];
}

export interface CollectiveIntelligence {
  id: string;
  type: 'emergent_behavior' | 'collective_decision' | 'group_optimization';
  intelligence: string;
  effectiveness: number;
  participatingAgents: string[];
  outcomes: string[];
}

export interface PerformanceMetrics {
  queryTime: number;
  memoryUsage: number;
  cacheHitRate: number;
  throughput: number;
  latency: number;
  averageResponseTime: number; // Added missing property
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  size: number;
  evictions: number;
  memoryCacheSize: number; // Added missing property
}

export interface ScalabilityMetrics {
  concurrentAgents: number;
  memoryGrowth: number;
  queryComplexity: number;
  systemLoad: number;
  maxConcurrentQueries: number; // Added missing property
}

export interface NeuralAIConfig {
  consolidation: {
    enabled: boolean;
    interval: number;
    threshold: number;
  };
  learning: {
    enabled: boolean;
    adaptationRate: number;
    patternRecognition: boolean;
  };
  collaboration: {
    enabled: boolean;
    collectiveIntelligence: boolean;
    synchronization: boolean;
  };
  performance: {
    caching: boolean;
    optimization: boolean;
    monitoring: boolean;
  };
}

export interface SystemStatus {
  overall: 'healthy' | 'degraded' | 'critical';
  components: {
    memory: 'healthy' | 'degraded' | 'critical';
    collaboration: 'healthy' | 'degraded' | 'critical';
    performance: 'healthy' | 'degraded' | 'critical';
    neural: 'healthy' | 'degraded' | 'critical';
  };
  metrics: {
    uptime: number;
    memoryUsage: number;
    activeAgents: number;
    eventCount: number;
  };
} 
