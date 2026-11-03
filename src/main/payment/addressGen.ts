/**
 * 中国账单地址生成器。
 *
 * 数据来自公开行政区划数据集（省 → 市 → 区 → 邮编，2023 口径），
 * 邮编与市/区真实对应，满足 Stripe 表单「邮编必须对得上」的要求；
 * 省市区名用拼音形态，与 Stripe 中国地址表单的命名习惯一致
 * （Hangzhou Shi / Jianggan Qu / Zhejiang）。
 */
import addressData from './cn-address.json'
import type { PaymentAddress } from '../../shared/types'

/** 生成的账单地址（英文形态，字段直接对应 Stripe 表单） */
export type BillingAddress = PaymentAddress

interface RawProvince {
  p: string
  pe: string
  cities: Array<{ c: string; ce: string; ds: Array<{ n: string; ne: string; z: string }> }>
}

const provinces = addressData as RawProvince[]

/** 常见路名（拼音形态与真实街景一致；Stripe 不校验街道真实性） */
const STREETS = [
  'Renmin Lu', 'Jiefang Lu', 'Zhongshan Lu', 'Jianshe Lu', 'Heping Lu', 'Xinhua Lu',
  'Minzu Lu', 'Wenhua Lu', 'Youyi Lu', 'Xingfu Lu', 'Guangming Lu', 'Shengli Lu',
  'Qingnian Lu', 'Binjiang Lu', 'Yanan Lu', 'Yucai Lu', 'Tiyu Lu', 'Gongyuan Lu',
  'Haiyan Lu', 'Fenghuang Lu', 'Tianhe Lu', 'Datong Lu', 'Taiping Lu', 'Yongxing Lu',
  'Jinxiu Lu', 'Chunhui Lu', 'Kangning Lu', 'Fuxing Lu', 'Wangjiang Lu', 'Chaoyang Lu',
  'Nanhuan Lu', 'Beihuan Lu', 'Dongfeng Lu', 'Hongqi Lu', 'Jinhe Lu', 'Yuelu Lu',
  'Zhonghua Lu', 'Changjiang Lu', 'Huanghe Lu', 'Yongjiang Lu', 'Zijin Lu', 'Baihua Lu'
]

/** 拼音姓（常见百家姓） */
const SURNAMES = [
  'Wang', 'Li', 'Zhang', 'Liu', 'Chen', 'Yang', 'Huang', 'Zhao', 'Wu', 'Zhou',
  'Xu', 'Sun', 'Ma', 'Zhu', 'Hu', 'Guo', 'He', 'Lin', 'Luo', 'Zheng',
  'Liang', 'Xie', 'Song', 'Tang', 'Deng', 'Feng', 'Han', 'Cao', 'Zeng', 'Peng',
  'Xiao', 'Cai', 'Pan', 'Tian', 'Dong', 'Yuan', 'Yu', 'Ye', 'Du', 'Su',
  'Wei', 'Cheng', 'Lu', 'Ding', 'Ren', 'Shen', 'Yao', 'Jiang', 'Cui', 'Zhong',
  'Tan', 'Lu', 'Fan', 'Jin', 'Shi', 'Liao', 'Jia', 'Xia', 'Wei', 'Fu',
  'Fang', 'Bai', 'Zou', 'Meng', 'Xiong', 'Qin', 'Qiu', 'Yin', 'Xue', 'Yan'
]

/** 拼音名（单字 + 双字混合，贴近真实取名分布） */
const GIVEN_NAMES = [
  'Xin', 'Tao', 'Lei', 'Ming', 'Hua', 'Jun', 'Qiang', 'Wei', 'Fang', 'Min',
  'Jing', 'Bo', 'Yu', 'Hao', 'Peng', 'Kai', 'Long', 'Fan', 'Yan', 'Yun',
  'Xinyu', 'Jiaming', 'Zihan', 'Yuchen', 'Haoran', 'Siqi', 'Xinyi', 'Jiale',
  'Wenbo', 'Zhiqiang', 'Lijun', 'Mingze', 'Yuhui', 'Tianyu', 'Chenxi', 'Yuxuan',
  'Shanshan', 'Xiaoting', 'Liting', 'Wanting', 'Jiaqi', 'Mengqi', 'Yuting'
]

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/** 省份中文列表（供界面下拉；按区划码顺序稳定输出） */
export function listProvinces(): string[] {
  return provinces.map((p) => p.p)
}

/** 校验省份中文名是否在数据集内 */
export function isValidProvince(provinceZh: string): boolean {
  return provinces.some((p) => p.p === provinceZh)
}

/**
 * 生成一条随机中国账单地址。
 * @param provinceZh 指定省份中文名（如 "浙江省"）；缺省或无效时随机挑一个省。
 */
export function generateBillingAddress(provinceZh?: string): BillingAddress {
  const prov = provinces.find((p) => p.p === provinceZh) || pick(provinces)
  const city = pick(prov.cities)
  const district = pick(city.ds)
  // 直筒子市（东莞/中山等）数据集里区县条目就是市自身，此时区名直接沿用市名
  const districtName = district.ne && district.ne !== city.ce ? district.ne : city.ce

  return {
    name: `${pick(SURNAMES)} ${pick(GIVEN_NAMES)}`.toUpperCase(),
    zip: district.z,
    city: city.ce,
    district: districtName,
    street: `${pick(STREETS)} ${Math.floor(1 + Math.random() * 398)}`,
    provinceZh: prov.p,
    provinceEn: prov.pe
  }
}
