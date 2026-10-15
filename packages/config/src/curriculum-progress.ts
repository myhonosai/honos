/** Inert human command metadata, deliberately not in ACTION_CATALOG or an AI tool. */
export const CURRICULUM_PROGRESS_COMMAND_REGISTRY = [
 {code:'curriculum.requirement.create',requiredPermission:'curriculum.manage'},
 {code:'curriculum.requirement.update',requiredPermission:'curriculum.manage'},
 {code:'curriculum.enrollment.enroll',requiredPermission:'curriculum.progress.record'},
 {code:'curriculum.enrollment.set_rank',requiredPermission:'curriculum.progress.record'},
 {code:'curriculum.progress.record',requiredPermission:'curriculum.progress.record'},
].map(command=>({...command,minimumTier:'ESSENTIAL',source:'HUMAN_UI',principalType:'HUMAN_USER',execution:'HUMAN_ONLY'})) as readonly {
 code:string; requiredPermission:string; minimumTier:'ESSENTIAL'; source:'HUMAN_UI'; principalType:'HUMAN_USER'; execution:'HUMAN_ONLY';
}[];
