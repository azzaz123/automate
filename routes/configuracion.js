// backend/routes/configuracion.js
const express = require('express');
const router = express.Router();

// ==========================================
// DATOS DE CONFIGURACIÓN CENTRALIZADOS
// ==========================================

const PAISES = [
  { value: '0', nombre: 'Seleccionar ...' },
  { value: '401', nombre: 'AFGANISTAN' },
  { value: '102', nombre: 'ALBANIA' },
  { value: '103', nombre: 'ALEMANIA' },
  { value: '133', nombre: 'ANDORRA' },
  { value: '301', nombre: 'ANGOLA' },
  { value: '258', nombre: 'ANGUILLA' },
  { value: '255', nombre: 'ANTIGUA Y BARBUDA' },
  { value: '200', nombre: 'ANTILLAS NL.' },
  { value: '600', nombre: 'APATRIDA' },
  { value: '403', nombre: 'ARABIA SAUDI' },
  { value: '304', nombre: 'ARGELIA' },
  { value: '202', nombre: 'ARGENTINA' },
  { value: '142', nombre: 'ARMENIA' },
  { value: '257', nombre: 'ARUBA' },
  { value: '500', nombre: 'AUSTRALIA' },
  { value: '104', nombre: 'AUSTRIA' },
  { value: '143', nombre: 'AZERBAYAN' },
  { value: '203', nombre: 'BAHAMAS' },
  { value: '405', nombre: 'BAHREIN' },
  { value: '432', nombre: 'BANGLADESH' },
  { value: '205', nombre: 'BARBADOS' },
  { value: '105', nombre: 'BELGICA' },
  { value: '207', nombre: 'BELICE' },
  { value: '302', nombre: 'BENIN' },
  { value: '407', nombre: 'BHUTAN' },
  { value: '144', nombre: 'BIELORRUSIA O BELARUS' },
  { value: '204', nombre: 'BOLIVIA' },
  { value: '156', nombre: 'BOSNIA-HERZEGOVINA' },
  { value: '305', nombre: 'BOTSWANA' },
  { value: '206', nombre: 'BRASIL' },
  { value: '409', nombre: 'BRUNEI DARUSSALAM' },
  { value: '134', nombre: 'BULGARIA' },
  { value: '303', nombre: 'BURKINA FASO' },
  { value: '321', nombre: 'BURUNDI' },
  { value: '315', nombre: 'CABO VERDE' },
  { value: '402', nombre: 'CAMBOYA' },
  { value: '308', nombre: 'CAMERUN' },
  { value: '208', nombre: 'CANADA' },
  { value: '310', nombre: 'CENTROAFRICA REPUBLICA' },
  { value: '372', nombre: 'CHAD' },
  { value: '210', nombre: 'CHILE' },
  { value: '406', nombre: 'CHINA' },
  { value: '107', nombre: 'CHIPRE' },
  { value: '212', nombre: 'COLOMBIA' },
  { value: '311', nombre: 'COMORES' },
  { value: '312', nombre: 'CONGO BRAZZAVILLE' },
  { value: '460', nombre: 'COREA, REP. POP. DEMOC.' },
  { value: '410', nombre: 'COREA, REPUBLICA' },
  { value: '314', nombre: 'COSTA DE MARFIL' },
  { value: '214', nombre: 'COSTA RICA' },
  { value: '140', nombre: 'CROACIA' },
  { value: '216', nombre: 'CUBA' },
  { value: '108', nombre: 'DINAMARCA' },
  { value: '317', nombre: 'DJIBOUTI' },
  { value: '217', nombre: 'DOMINICA' },
  { value: '218', nombre: 'DOMINICANA REPUBLICA' },
  { value: '222', nombre: 'ECUADOR' },
  { value: '224', nombre: 'EEUU' },
  { value: '300', nombre: 'EGIPTO' },
  { value: '220', nombre: 'EL SALVADOR' },
  { value: '136', nombre: 'EL VATICANO' },
  { value: '429', nombre: 'EMIRATOS ARABES UNIDOS' },
  { value: '384', nombre: 'ERITREA' },
  { value: '158', nombre: 'ESLOVAQUIA' },
  { value: '141', nombre: 'ESLOVENIA' },
  { value: '109', nombre: 'ESPAÑA' },
  { value: '137', nombre: 'ESTONIA' },
  { value: '318', nombre: 'ETIOPIA' },
  { value: '550', nombre: 'FIDJI' },
  { value: '411', nombre: 'FILIPINAS' },
  { value: '110', nombre: 'FINLANDIA' },
  { value: '111', nombre: 'FRANCIA' },
  { value: '320', nombre: 'GABON' },
  { value: '323', nombre: 'GAMBIA' },
  { value: '145', nombre: 'GEORGIA' },
  { value: '322', nombre: 'GHANA' },
  { value: '229', nombre: 'GRANADA REPUBLICA' },
  { value: '113', nombre: 'GRECIA' },
  { value: '228', nombre: 'GUATEMALA' },
  { value: '225', nombre: 'GUAYANA' },
  { value: '324', nombre: 'GUINEA ECUATORIAL' },
  { value: '325', nombre: 'GUINEA REPUBLICA' },
  { value: '328', nombre: 'GUINEA-BISSAU' },
  { value: '230', nombre: 'HAITI' },
  { value: '123', nombre: 'HOLANDA' },
  { value: '232', nombre: 'HONDURAS' },
  { value: '114', nombre: 'HUNGRIA' },
  { value: '412', nombre: 'INDIA' },
  { value: '414', nombre: 'INDONESIA' },
  { value: '413', nombre: 'IRAK' },
  { value: '415', nombre: 'IRAN' },
  { value: '115', nombre: 'IRLANDA' },
  { value: '116', nombre: 'ISLANDIA' },
  { value: '520', nombre: 'ISLAS MARSCHALL' },
  { value: '417', nombre: 'ISRAEL' },
  { value: '117', nombre: 'ITALIA' },
  { value: '233', nombre: 'JAMAICA' },
  { value: '416', nombre: 'JAPON' },
  { value: '419', nombre: 'JORDANIA' },
  { value: '146', nombre: 'KAZAJSTAN' },
  { value: '336', nombre: 'KENIA' },
  { value: '147', nombre: 'KIRGUISTAN' },
  { value: '501', nombre: 'KIRIBATI' },
  { value: '421', nombre: 'KUWAIT' },
  { value: '418', nombre: 'LAOS' },
  { value: '436', nombre: 'LAS MALDIVAS' },
  { value: '337', nombre: 'LESOTHO' },
  { value: '138', nombre: 'LETONIA' },
  { value: '423', nombre: 'LIBANO' },
  { value: '342', nombre: 'LIBERIA' },
  { value: '344', nombre: 'LIBIA' },
  { value: '118', nombre: 'LIECHTENSTEIN' },
  { value: '139', nombre: 'LITUANIA' },
  { value: '119', nombre: 'LUXEMBURGO' },
  { value: '463', nombre: 'MACAO' },
  { value: '159', nombre: 'MACEDONIA' },
  { value: '354', nombre: 'MADAGASCAR' },
  { value: '425', nombre: 'MALASIA' },
  { value: '900', nombre: 'MALASIA - GRAN BRETAÑA' },
  { value: '346', nombre: 'MALAWI' },
  { value: '347', nombre: 'MALI' },
  { value: '120', nombre: 'MALTA' },
  { value: '348', nombre: 'MARRUECOS' },
  { value: '349', nombre: 'MAURICIO' },
  { value: '350', nombre: 'MAURITANIA' },
  { value: '234', nombre: 'MEJICO' },
  { value: '525', nombre: 'MICRONESIA' },
  { value: '148', nombre: 'MOLDAVIA' },
  { value: '121', nombre: 'MONACO' },
  { value: '427', nombre: 'MONGOLIA' },
  { value: '160', nombre: 'MONTENEGRO' },
  { value: '351', nombre: 'MOZAMBIQUE' },
  { value: '400', nombre: 'MYANMAR' },
  { value: '353', nombre: 'NAMIBIA' },
  { value: '541', nombre: 'NAURU' },
  { value: '420', nombre: 'NEPAL' },
  { value: '236', nombre: 'NICARAGUA' },
  { value: '360', nombre: 'NIGER' },
  { value: '352', nombre: 'NIGERIA' },
  { value: '122', nombre: 'NORUEGA' },
  { value: '540', nombre: 'NUEVA ZELANDA' },
  { value: '444', nombre: 'OMAN' },
  { value: '424', nombre: 'PAKISTAN' },
  { value: '920', nombre: 'PALAOS' },
  { value: '910', nombre: 'PALESTINA' },
  { value: '238', nombre: 'PANAMA' },
  { value: '542', nombre: 'PAPUA NUEVA GUINEA' },
  { value: '240', nombre: 'PARAGUAY' },
  { value: '242', nombre: 'PERU' },
  { value: '124', nombre: 'POLONIA' },
  { value: '125', nombre: 'PORTUGAL' },
  { value: '244', nombre: 'PUERTO RICO' },
  { value: '431', nombre: 'QATAR' },
  { value: '112', nombre: 'REINO UNIDO' },
  { value: '380', nombre: 'REP. DEMOCRATICA DEL CONGO (EX-ZAIRE)' },
  { value: '157', nombre: 'REPUBLICA CHECA' },
  { value: '355', nombre: 'REUNION-COMO' },
  { value: '306', nombre: 'RUANDA' },
  { value: '127', nombre: 'RUMANIA' },
  { value: '149', nombre: 'RUSIA' },
  { value: '551', nombre: 'SALOMON' },
  { value: '552', nombre: 'SAMOA OCCIDENTAL' },
  { value: '256', nombre: 'SAN CRISTOBAL Y NEVIS' },
  { value: '135', nombre: 'SAN MARINO' },
  { value: '254', nombre: 'SAN VICENTE' },
  { value: '253', nombre: 'SANTA LUCIA' },
  { value: '361', nombre: 'SANTO TOME Y PRINCIPE' },
  { value: '363', nombre: 'SEICHELLES' },
  { value: '362', nombre: 'SENEGAL' },
  { value: '366', nombre: 'SENEGAMBIA' },
  { value: '155', nombre: 'SERBIA' },
  { value: '364', nombre: 'SIERRA LEONA' },
  { value: '426', nombre: 'SINGAPUR' },
  { value: '433', nombre: 'SIRIA' },
  { value: '365', nombre: 'SOMALIA' },
  { value: '404', nombre: 'SRI LANKA' },
  { value: '367', nombre: 'SUDAFRICA' },
  { value: '368', nombre: 'SUDAN' },
  { value: '128', nombre: 'SUECIA' },
  { value: '129', nombre: 'SUIZA' },
  { value: '250', nombre: 'SURINAM' },
  { value: '371', nombre: 'SWAZILANDIA' },
  { value: '154', nombre: 'TADJIKISTAN' },
  { value: '408', nombre: 'TAIWAN' },
  { value: '370', nombre: 'TANZANIA' },
  { value: '428', nombre: 'THAILANDIA' },
  { value: '465', nombre: 'TIMOR ORIENTAL' },
  { value: '374', nombre: 'TOGO' },
  { value: '554', nombre: 'TONGA' },
  { value: '245', nombre: 'TRINIDAD Y TOBAGO' },
  { value: '378', nombre: 'TUNEZ' },
  { value: '151', nombre: 'TURKMENIA' },
  { value: '130', nombre: 'TURQUIA' },
  { value: '560', nombre: 'TUVALU' },
  { value: '152', nombre: 'UCRANIA' },
  { value: '358', nombre: 'UGANDA' },
  { value: '246', nombre: 'URUGUAY' },
  { value: '153', nombre: 'UZBEKISTAN' },
  { value: '565', nombre: 'VANUATU' },
  { value: '248', nombre: 'VENEZUELA' },
  { value: '430', nombre: 'VIETNAM' },
  { value: '434', nombre: 'YEMEN' },
  { value: '382', nombre: 'ZAMBIA' },
  { value: '357', nombre: 'ZIMBABWE' },
];

const OFICINAS_POR_PROVINCIA = {
  'Madrid': {
    tramiteGrupo: '0',
    oficinas: [
      { value: '7', nombre: 'CNP AVDA POBLADOS, Avda. de los Poblados, S/N, MADRID' },
      { value: '59', nombre: 'CNP COLMENAR VIEJO, Carlos Aragón Cancela, 5, Colmenar Viejo' },
      { value: '15', nombre: 'CNP Comisaría de Alcalá de Henares, Avda. de Meco, s/n, ALCALÁ DE HENARES' },
      { value: '16', nombre: 'CNP Comisaría de Alcobendas, Avda. de España, 52, ALCOBENDAS' },
      { value: '17', nombre: 'CNP Comisaría de Alcorcón, Alfredo Nobel, 10, ALCORCÓN' },
      { value: '18', nombre: 'CNP Comisaría de Aranjuez, Avda. Príncipe, 40, ARANJUEZ' },
      { value: '27', nombre: 'CNP Comisaría de Arganda del Rey, Av.Mediterraneo(PoliciaLocal), 7, ARGANDA DEL REY' },
      { value: '28', nombre: 'CNP Comisaría de Collado Villalba, SAN FERNANDO, 27, COLLADO VILLALBA' },
      { value: '19', nombre: 'CNP Comisaría de Coslada, Guadalquivir, 16, COSLADA' },
      { value: '20', nombre: 'CNP Comisaría de Fuenlabrada, Calle de los Ángeles, 9, FUENLABRADA' },
      { value: '21', nombre: 'CNP Comisaría de Getafe, Churruca, 6, GETAFE' },
      { value: '39', nombre: 'CNP Comisaría de Las Rozas de Madrid, José Echegaray, 10, Las Rozas de Madrid' },
      { value: '22', nombre: 'CNP Comisaría de Leganés, Avda. de Universidad, 27, LEGANÉS' },
      { value: '29', nombre: 'CNP Comisaría de Majadahonda, Ctra.Villanueva del Pardillo, 3, MAJADAHONDA' },
      { value: '23', nombre: 'CNP Comisaría de Móstoles, Granada, 9, MÓSTOLES' },
      { value: '24', nombre: 'CNP Comisaría de Parla, Avda. Juan Carlos I, 2, PARLA' },
      { value: '25', nombre: 'CNP Comisaría de Pozuelo de Alarcón, Camino de las Huertas, 36, POZUELO DE ALARCÓN' },
      { value: '30', nombre: 'CNP Comisaría de Rivas Vaciamadrid, José Hierro, 82, RIVAS-VACIAMADRID' },
      { value: '26', nombre: 'CNP Comisaría de Torrejón de Ardoz, Hilados, 15, TORREJÓN DE ARDOZ' },
      { value: '31', nombre: 'CNP Comisaría de Valdemoro, Avda. de España, 97, VALDEMORO' },
      { value: '35', nombre: 'Comisaría de Getafe 2, churruca, 6, getafe' },
    ],
  },
  'A Coruña': {
    tramiteGrupo: '1',
    oficinas: [
      { value: '4', nombre: 'CNP SANTIAGO COMPOSTELA EXTRANJEROS, AVD RODRIGO DE PADRON, SN, SANTIAGO DE COMPOSTELA' },
      { value: '2', nombre: 'CNP COMISARIA A CORUÑA - LONZAS, C\\ Médico Devesa Núñez, 4, A Coruña' },
      { value: '5', nombre: 'CNP FERROL, AVENIDA DE SAN AMARO, S/N, FERROL' },
      { value: '3', nombre: 'CNP Santa Uxía de Ribeira, Av/ Das Airos , 21, Ribeira' },
    ],
  },
  'Toledo': {
    tramiteGrupo: '1',
    oficinas: [
      { value: '4', nombre: 'CNP POLICIA TALAVERA DE LA REINA, CARLOS BARRAL, 2, TALAVERA DE LA REINA' },
      { value: '1', nombre: 'OFICINA EXTRANJEROS TOLEDO, RONDA DE BUENAVISTA, 57, TOLEDO' },
    ],
  },
  'Albacete': {
    tramiteGrupo: '0',
    oficinas: [
      { value: '4', nombre: 'CNP HELLIN, FORTUNATO ARIAS, 2, HELLIN' },
      { value: '2', nombre: 'CNP TARJETAS Expedición, CALDERON DE LA BARCA, 2, ALBACETE' },
    ],
  },
  'Alicante': {
    tramiteGrupo: '1',
    oficinas: [
      { value: '3', nombre: 'CNP Alicante TIE, Campo de Mirra, 6, Alicante' },
    ],
  },
  'Almería': {
    tramiteGrupo: '1',
    oficinas: [
      { value: '1', nombre: 'Almería OUE, C/ Marruecos, 1, Almería' },
      { value: '4', nombre: 'CNP EL EJIDO, Avenida del bulevar, 117, El Ejido' },
      { value: '2', nombre: 'CNP ROQUETAS DE MAR DGP UEYD, Avda. Curro Romero, 46, Roquetas de Mar' },
    ],
  },
  'Araba': {
    tramiteGrupo: '1',
    oficinas: [
      { value: '2', nombre: 'CNP Comisaría Oficina de tramitación, Olaguibel, 15, Vitoria-Gasteiz' },
    ],
  },
  'Asturias': {
    tramiteGrupo: '1',
    oficinas: [
      { value: '5', nombre: 'CNP AVILES, Río San Martín, 2, AVILES' },
      { value: '2', nombre: 'CNP GIJÓN, Plaza Máximo Gonzalez, s/n, Gijón' },
      { value: '4', nombre: 'CNP LUARCA, OLAVARRIETA, 25, LUARCA' },
      { value: '3', nombre: 'CNP OVIEDO - EXPEDICION TIE, Plaza de España, 3, Oviedo' },
    ],
  },
  'Ávila': {
    tramiteGrupo: '1',
    oficinas: [
      { value: '2', nombre: 'CNP ÁVILA, PASEO SAN ROQUE, 34, ÁVILA' },
    ],
  },
  'Badajoz': {
    tramiteGrupo: '1',
    oficinas: [
      { value: '4', nombre: 'CNP ALMENDRALEJO, Benito Pérez Galdós, S/N, ALMENDRALEJO' },
      { value: '2', nombre: 'CNP BADAJOZ CITA PREVIA POLICÍA TARJETAS, LA BOMBA, 9, BADAJOZ' },
      { value: '5', nombre: 'CNP DON BENITO, AVENIDA DE CORDOBA, S/N, DON BENITO' },
      { value: '8', nombre: 'CNP MÉRIDA TARJETAS, AVENIDA VALHONDO, 8, MÉRIDA-BADAJOZ' },
      { value: '6', nombre: 'CNP ZAFRA, PLAZA DEL PILAR REDONDO S/N, ZAFRA' },
    ],
  },
  'Valencia': {
    tramiteGrupo: '0',
    oficinas: [
      { value: '8', nombre: 'CNP COMISARIA DE ALZIRA, Pere Morell, 4, ALZIRA' },
      { value: '6', nombre: 'CNP COMISARIA DE ONTENIENTE, Plaza de Escura, 2, ONTENIENTE' },
      { value: '5', nombre: 'CNP GANDIA EXPEDICION TIE, Ciudad de Laval, 5, Gandia' },
    ],
  },
  'Barcelona': {
    tramiteGrupo: '0',
    oficinas: [
      { value: '18', nombre: 'CNP COMISARIA BADALONA, AVDA. DELS VENTS, 9, BADALONA' },
      { value: '19', nombre: 'CNP COMISARIA CASTELLDEFELS, PLAÇA DE L`ESPERANTO, 4, CASTELLDEFELS' },
      { value: '20', nombre: 'CNP COMISARIA CERDANYOLA DEL VALLES, VERGE DE LES FEIXES, 4, CERDANYOLA DEL VALLES' },
      { value: '21', nombre: 'CNP COMISARIA CORNELLA DE LLOBREGAT, AV. SANT ILDEFONS, S/N, CORNELLA DE LLOBREGAT' },
      { value: '23', nombre: 'CNP COMISARIA EL PRAT DE LLOBREGAT, CENTRE, 4, EL PRAT DE LLOBREGAT' },
      { value: '28', nombre: 'CNP COMISARIA GRANOLLERS, RICOMA, 65, GRANOLLERS' },
      { value: '26', nombre: 'CNP COMISARIA IGUALADA, PRAT DE LA RIBA, 13, IGUALADA' },
      { value: '17', nombre: 'CNP COMISARIA LHOSPITALET DE LLOBREGAT, Rbla. Just Oliveres, 43, L`HOSPITALET DE LLOBREGAT' },
      { value: '38', nombre: 'CNP COMISARIA MANRESA, SOLER I MARCH, 5, MANRESA' },
      { value: '27', nombre: 'CNP COMISARIA MATARO, AV. GATASSA, 15, MATARO' },
      { value: '31', nombre: 'CNP COMISARIA MONTCADA I REIXAC, MAJOR, 38, MONTCADA I REIXAC' },
      { value: '32', nombre: 'CNP COMISARIA RIPOLLET, TAMARIT, 78, RIPOLLET' },
      { value: '29', nombre: 'CNP COMISARIA RUBI, TERRASSA, 16, RUBI' },
      { value: '30', nombre: 'CNP COMISARIA SABADELL, BATLLEVELL, 115, SABADELL' },
      { value: '33', nombre: 'CNP COMISARIA SANT ADRIA DEL BESOS, AV. JOAN XXIII, 2, SANT ADRIA DEL BESOS' },
      { value: '24', nombre: 'CNP COMISARIA SANT BOI DE LLOBREGAT, RIERA BASTÉ, 43, SANT BOI DE LLOBREGAT' },
      { value: '34', nombre: 'CNP COMISARIA SANT CUGAT DEL VALLES, VALLES, 1, SANT CUGAT DEL VALLES' },
      { value: '22', nombre: 'CNP COMISARIA SANT FELIU DE LLOBREGAT, CARRERETES, 9, SANT FELIU DE LLOBREGAT' },
      { value: '35', nombre: 'CNP COMISARIA SANTA COLOMA DE GRAMENET, IRLANDA, 67, SANTA COLOMA DE GRAMENET' },
      { value: '36', nombre: 'CNP COMISARIA TERRASSA, BALDRICH, 13, TERRASSA' },
      { value: '37', nombre: 'CNP COMISARIA VIC, BISBE MORGADES, 4, VIC' },
      { value: '25', nombre: 'CNP COMISARIA VILADECANS, AVDA. BALLESTER, 2, VILADECANS' },
      { value: '46', nombre: 'CNP COMISARIA VILAFRANCA DEL PENEDES, Avinguda Ronda del Mar, 109, VILAFRANCA DEL PENEDES' },
      { value: '49', nombre: 'CNP COMISARIA VILANOVA I LA GELTRU, CARRER D`OLÉRDOLA, 47, Vilanova i la Geltrú' },
      { value: '16', nombre: 'CNP RAMBLA GUIPUSCOA 74, RAMBLA GUIPUSCOA, 74, BARCELONA' },
    ],
  },
  'Soria': {
    tramiteGrupo: '1',
    oficinas: [
      { value: '1', nombre: 'Oficina de Extranjería en Soria, Alfonso VIII, 2, Soria' },
    ],
  },
};

const HORARIOS_DEFECTO = [
  { inicio: 22, fin: 24, activo: true, dias: [0, 1, 2, 3, 4, 5, 6] },
];

const DIAS_SEMANA = [
  { value: 1, nombre: 'L', nombreCompleto: 'Lunes' },
  { value: 2, nombre: 'M', nombreCompleto: 'Martes' },
  { value: 3, nombre: 'X', nombreCompleto: 'Miércoles' },
  { value: 4, nombre: 'J', nombreCompleto: 'Jueves' },
  { value: 5, nombre: 'V', nombreCompleto: 'Viernes' },
  { value: 6, nombre: 'S', nombreCompleto: 'Sábado' },
  { value: 0, nombre: 'D', nombreCompleto: 'Domingo' },
];

const MESES = [
  { value: 0, nombre: 'Enero' },
  { value: 1, nombre: 'Febrero' },
  { value: 2, nombre: 'Marzo' },
  { value: 3, nombre: 'Abril' },
  { value: 4, nombre: 'Mayo' },
  { value: 5, nombre: 'Junio' },
  { value: 6, nombre: 'Julio' },
  { value: 7, nombre: 'Agosto' },
  { value: 8, nombre: 'Septiembre' },
  { value: 9, nombre: 'Octubre' },
  { value: 10, nombre: 'Noviembre' },
  { value: 11, nombre: 'Diciembre' },
];

// ==========================================
// RUTAS DE CONFIGURACIÓN
// ==========================================

// Obtener toda la configuración
router.get('/todo', (req, res) => {
  res.json({
    success: true,
    data: {
      paises: PAISES,
      oficinasPorProvincia: OFICINAS_POR_PROVINCIA,
      horariosDefecto: HORARIOS_DEFECTO,
      diasSemana: DIAS_SEMANA,
      meses: MESES,
    },
    version: '1.0.0',
    actualizado: new Date().toISOString(),
  });
});

// Obtener solo países
router.get('/paises', (req, res) => {
  res.json({ success: true, data: PAISES });
});

// Obtener oficinas por provincia
router.get('/oficinas/:provincia', (req, res) => {
  const provincia = decodeURIComponent(req.params.provincia);
  const data = OFICINAS_POR_PROVINCIA[provincia];
  
  if (data) {
    res.json({ success: true, data });
  } else {
    res.status(404).json({ success: false, error: 'Provincia no encontrada' });
  }
});

// Obtener todas las provincias
router.get('/provincias', (req, res) => {
  const provincias = Object.keys(OFICINAS_POR_PROVINCIA);
  res.json({ success: true, data: provincias });
});

// Obtener horarios
router.get('/horarios', (req, res) => {
  res.json({ success: true, data: HORARIOS_DEFECTO });
});

// Obtener días de la semana
router.get('/dias', (req, res) => {
  res.json({ success: true, data: DIAS_SEMANA });
});

// Obtener meses
router.get('/meses', (req, res) => {
  res.json({ success: true, data: MESES });
});

module.exports = router;