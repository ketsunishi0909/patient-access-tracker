import { type CaseMeta, DomainError, type Role, type User } from './types';

export type Permission =
  | 'case:list'
  | 'case:create'
  | 'case:update:own'      // edit cases you own (or claim unassigned ones)
  | 'case:update:any'
  | 'case:assign'          // reassign cases between staff
  | 'phi:view:own'         // see DOB, member ID and phone on cases you own
  | 'phi:view:any'
  | 'patient:name'         // see patient names (otherwise initials only)
  | 'case:view:any'        // open any case (otherwise own and unassigned only)
  | 'ai:draft'
  | 'audit:view';

/**
 * Role -> permission matrix. Built on "minimum necessary": staff see the
 * protected fields they need for their own work, and the compliance auditor
 * sees who accessed what without seeing patient details.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  INTAKE_COORDINATOR: ['case:list', 'case:create', 'case:update:own', 'phi:view:own', 'patient:name', 'ai:draft'],
  CASE_MANAGER: ['case:list', 'case:create', 'case:update:own', 'phi:view:own', 'patient:name', 'case:view:any', 'ai:draft'],
  SUPERVISOR: ['case:list', 'case:create', 'case:update:any', 'case:assign', 'phi:view:any', 'patient:name',
               'case:view:any', 'ai:draft', 'audit:view'],
  COMPLIANCE_AUDITOR: ['case:list', 'case:view:any', 'audit:view'],
};

export function can(user: User, p: Permission): boolean {
  return ROLE_PERMISSIONS[user.role].includes(p);
}

export function requirePermission(user: User, p: Permission): void {
  if (!can(user, p)) throw new DomainError('FORBIDDEN', `${user.role} lacks permission ${p}`);
}

const ownsOrUnassigned = (user: User, c: CaseMeta) => c.ownerId === user.id || c.ownerId === null;

export function canViewCase(user: User, c: CaseMeta): boolean {
  return can(user, 'case:view:any') || (can(user, 'case:list') && ownsOrUnassigned(user, c));
}

export function canUpdateCase(user: User, c: CaseMeta): boolean {
  return can(user, 'case:update:any') || (can(user, 'case:update:own') && ownsOrUnassigned(user, c));
}

export function canViewPhi(user: User, c: CaseMeta): boolean {
  return can(user, 'phi:view:any') || (can(user, 'phi:view:own') && c.ownerId === user.id);
}

export function canDraft(user: User, c: CaseMeta): boolean {
  return can(user, 'ai:draft') && canUpdateCase(user, c);
}

export interface PatientView {
  displayName: string;
  dateOfBirth: string | null;
  memberId: string | null;
  phone: string | null;
  masked: boolean;
}

/** The patient fields this user may see on this case. */
export function patientView(user: User, c: CaseMeta): PatientView {
  const p = c.patient;
  const phi = canViewPhi(user, c);
  return {
    displayName: can(user, 'patient:name') ? `${p.firstName} ${p.lastName}` : `${p.firstName[0]}. ${p.lastName[0]}.`,
    dateOfBirth: phi ? p.dateOfBirth : null,
    memberId: phi ? p.memberId : `•••${p.memberId.slice(-3)}`,
    phone: phi ? p.phone : null,
    masked: !phi,
  };
}
