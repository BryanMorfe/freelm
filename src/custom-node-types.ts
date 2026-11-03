import type { WorkflowPort } from './workflow-types';
import type { WorkflowField } from './lib/workflow-catalog';
export interface CustomNodeManifest {
  id: string;
  version: string;
  title: string;
  description: string;
  inputs: WorkflowPort[];
  outputs: WorkflowPort[];
  fields: (Omit<WorkflowField, 'kind'> & { kind?: WorkflowField['kind'] | 'secret' })[];
  permissions: { network?: string[]; inference?: boolean };
  retrySafe?: boolean;
  discovery?: boolean;
}
export interface InstalledCustomNode {
  grants?: { network: string[]; inference: boolean };
  secrets?: { name: string; origin: string }[];
  manifest: CustomNodeManifest;
  digest: string;
}
export interface CustomNodeReference {
  packageId: string;
  version: string;
  digest: string;
  definition: CustomNodeManifest;
}
