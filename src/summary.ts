import type { TriageOperation } from './triage';

export interface ActionSummary {
  issueNumber: number;
  operations: TriageOperation[];
}

export function formatActionSummary(actionSummaries: ActionSummary[]): string[] {
  const lines: string[] = [];
  
  for (const { issueNumber, operations } of actionSummaries) {
    const actionDescriptions: string[] = [];
    
    for (const op of operations) {
      const opData = op.toJSON();
      switch (op.kind) {
        case 'labels':
          const parts: string[] = [];
          if (opData.toAdd?.length > 0) {
            parts.push(`+${opData.toAdd.join(', +')}`);
          }
          if (opData.toRemove?.length > 0) {
            parts.push(`-${opData.toRemove.join(', -')}`);
          }
          if (parts.length > 0) {
            actionDescriptions.push(`labels: ${parts.join(', ')}`);
          }
          break;
        case 'comment':
          actionDescriptions.push('comment');
          break;
        case 'title':
          actionDescriptions.push('title change');
          break;
        case 'state':
          actionDescriptions.push(`state: ${opData.state}`);
          break;
      }
    }
    
    if (actionDescriptions.length > 0) {
      lines.push(`#${issueNumber}: ${actionDescriptions.join(', ')}`);
    }
  }
  
  return lines;
}
