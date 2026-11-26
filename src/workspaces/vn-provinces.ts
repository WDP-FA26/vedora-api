/**
 * Vietnam's 34 provinces and centrally run cities after the merger of
 * 1 July 2025 (Nghị quyết 202/2025/QH15). The frontend mirrors these codes.
 */
export const VN_PROVINCES = {
  'ha-noi': 'Thành phố Hà Nội',
  hue: 'Thành phố Huế',
  'hai-phong': 'Thành phố Hải Phòng',
  'da-nang': 'Thành phố Đà Nẵng',
  'ho-chi-minh': 'Thành phố Hồ Chí Minh',
  'can-tho': 'Thành phố Cần Thơ',
  'lai-chau': 'Lai Châu',
  'dien-bien': 'Điện Biên',
  'son-la': 'Sơn La',
  'lang-son': 'Lạng Sơn',
  'quang-ninh': 'Quảng Ninh',
  'thanh-hoa': 'Thanh Hóa',
  'nghe-an': 'Nghệ An',
  'ha-tinh': 'Hà Tĩnh',
  'cao-bang': 'Cao Bằng',
  'tuyen-quang': 'Tuyên Quang',
  'lao-cai': 'Lào Cai',
  'thai-nguyen': 'Thái Nguyên',
  'phu-tho': 'Phú Thọ',
  'bac-ninh': 'Bắc Ninh',
  'hung-yen': 'Hưng Yên',
  'ninh-binh': 'Ninh Bình',
  'quang-tri': 'Quảng Trị',
  'quang-ngai': 'Quảng Ngãi',
  'gia-lai': 'Gia Lai',
  'khanh-hoa': 'Khánh Hòa',
  'lam-dong': 'Lâm Đồng',
  'dak-lak': 'Đắk Lắk',
  'dong-nai': 'Đồng Nai',
  'tay-ninh': 'Tây Ninh',
  'vinh-long': 'Vĩnh Long',
  'dong-thap': 'Đồng Tháp',
  'ca-mau': 'Cà Mau',
  'an-giang': 'An Giang',
} as const;

export type VnProvinceCode = keyof typeof VN_PROVINCES;

export const VN_PROVINCE_CODES = Object.keys(VN_PROVINCES) as VnProvinceCode[];
