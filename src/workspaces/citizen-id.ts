const BIRTH_PROVINCE_CODES: ReadonlySet<string> = new Set([
  '001', '002', '004', '006', '008', '010', '011', '012', '014', '015',
  '017', '019', '020', '022', '024', '025', '026', '027', '030', '031',
  '033', '034', '035', '036', '037', '038', '040', '042', '044', '045',
  '046', '048', '049', '051', '052', '054', '056', '058', '060', '062',
  '064', '066', '067', '068', '070', '072', '074', '075', '077', '079',
  '080', '082', '083', '084', '086', '087', '089', '091', '092', '093',
  '094', '095', '096',
]); // prettier-ignore

const CITIZEN_ID = /^\d{12}$/;

function birthCentury(sexAndCentury: string): number | null {
  if (sexAndCentury === '0' || sexAndCentury === '1') return 1900;
  if (sexAndCentury === '2' || sexAndCentury === '3') return 2000;
  return null;
}

export function isWellFormedCitizenId(
  value: string,
  today = new Date(),
): boolean {
  if (!CITIZEN_ID.test(value)) return false;
  if (!BIRTH_PROVINCE_CODES.has(value.slice(0, 3))) return false;
  const century = birthCentury(value.charAt(3));
  if (century === null) return false;
  const birthYear = century + Number(value.slice(4, 6));
  return birthYear <= today.getFullYear();
}
