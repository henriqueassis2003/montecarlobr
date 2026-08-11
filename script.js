/**
 * Calculando área de estados com Monte Carlo
 * 
 * Aspectos matemáticos fundamentais:
 * 1. Amostragem Esférica Uniforme:
 *    A longitude é distribuída uniformemente. A latitude é amostrada através de 
 *    sin(lat) ~ Uniforme(sin(minLat), sin(maxLat)), evitando maior densidade de pontos 
 *    próximo aos pólos e garantindo amostragem uniforme em área real da esfera terrestre.
 * 
 * 2. Área do Retângulo Delimitador (Bounding Box) Esférico:
 *    Calculada por A = R^2 * (lonMax - lonMin)_rad * (sin(latMax_rad) - sin(latMin_rad)).
 * 
 * 3. Ray Casting & Tratamento de Degenerações:
 *    Se um ponto sorteado atinge ou passa muito próximo (com tolerância EPSILON) de qualquer
 *    vértice ou aresta horizontal, ele é sinalizado como degenerado/ambíguo, sendo
 *    completamente descartado e reamostrado para manter o rigor estatístico.
 */

// Constantes Globais
const EARTH_RADIUS_KM = 6371.0088; // Raio médio da Terra (WGS84) em km
const EPSILON = 1e-8;               // Tolerância numérica para evitar ambiguidade do Ray Casting

// Estado Global da Aplicação
let officialAreas = {};
let currentGeoJson = null;
let currentBoundingBox = null;
let animationFrameId = null;
let isCalculating = false;

// Elementos da Interface DOM
const stateSelect = document.getElementById('stateSelect');
const pointsSelect = document.getElementById('pointsSelect');
const btnCalculate = document.getElementById('btnCalculate');
const btnClear = document.getElementById('btnClear');
const mapCanvas = document.getElementById('mapCanvas');
const ctx = mapCanvas.getContext('2d');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');

// Elementos das Métricas
const metricState = document.getElementById('metricState');
const metricTargetPoints = document.getElementById('metricTargetPoints');
const metricDiscardedPoints = document.getElementById('metricDiscardedPoints');
const metricPointsInside = document.getElementById('metricPointsInside');
const metricPointsOutside = document.getElementById('metricPointsOutside');
const metricBboxArea = document.getElementById('metricBboxArea');
const metricCalculatedArea = document.getElementById('metricCalculatedArea');
const metricRealArea = document.getElementById('metricRealArea');
const metricAbsError = document.getElementById('metricAbsError');
const metricRelError = document.getElementById('metricRelError');

// Inicialização da Aplicação
document.addEventListener('DOMContentLoaded', async () => {
    setupCanvasResolution();
    window.addEventListener('resize', setupCanvasResolution);

    try {
        await loadOfficialAreas();
        await loadSelectedStateGeoJson();
    } catch (error) {
        console.error("Erro na inicialização:", error);
        alert("Erro ao carregar dados iniciais. Certifique-se de estar rodando via servidor HTTP local.");
    }

    stateSelect.addEventListener('change', async () => {
        if (isCalculating) cancelCalculation();
        await loadSelectedStateGeoJson();
    });

    btnCalculate.addEventListener('click', startMonteCarloSimulation);
    btnClear.addEventListener('click', resetSimulation);
});

/**
 * Ajusta a resolução do Canvas de acordo com o Pixel Ratio da tela para renderização nítida
 */
function setupCanvasResolution() {
    const rect = mapCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    
    mapCanvas.width = rect.width * dpr;
    mapCanvas.height = rect.height * dpr;
    
    ctx.scale(dpr, dpr);
    redrawScene();
}

/**
 * Carrega a tabela de áreas oficiais (areas.json)
 */
async function loadOfficialAreas() {
    const response = await fetch('areas.json');
    if (!response.ok) throw new Error('Não foi possível carregar areas.json');
    officialAreas = await response.json();
}

/**
 * Carrega o arquivo GeoJSON do estado selecionado
 */
async function loadSelectedStateGeoJson() {
    const uf = stateSelect.value.toLowerCase();
    const response = await fetch(`geojson/br_${uf}.json`);
    if (!response.ok) throw new Error(`Não foi possível carregar o GeoJSON do estado: ${uf}`);
    
    currentGeoJson = await response.json();
    currentBoundingBox = calculateBoundingBox(currentGeoJson);
    
    resetSimulation();
}

/**
 * Calcula a Bounding Box [minLon, minLat, maxLon, maxLat] a partir da geometria GeoJSON
 */
function calculateBoundingBox(geoJson) {
    let minLon = Infinity, maxLon = -Infinity;
    let minLat = Infinity, maxLat = -Infinity;

    function processCoords(coords) {
        if (typeof coords[0] === 'number') {
            const lon = coords[0];
            const lat = coords[1];
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
        } else {
            for (let i = 0; i < coords.length; i++) {
                processCoords(coords[i]);
            }
        }
    }

    const features = geoJson.type === 'FeatureCollection' ? geoJson.features : [geoJson];
    features.forEach(feature => {
        const geom = feature.geometry || feature;
        processCoords(geom.coordinates);
    });

    return { minLon, minLat, maxLon, maxLat };
}

/**
 * Converte graus em radianos
 */
function toRadians(degrees) {
    return degrees * Math.PI / 180;
}

/**
 * Calcula a área da Bounding Box sobre a superfície da esfera terrestre em km²
 */
function calculateSphericalBboxArea(bbox) {
    const deltaLonRad = toRadians(bbox.maxLon - bbox.minLon);
    const sinLatMin = Math.sin(toRadians(bbox.minLat));
    const sinLatMax = Math.sin(toRadians(bbox.maxLat));
    
    const deltaSinLat = sinLatMax - sinLatMin;
    
    return EARTH_RADIUS_KM * EARTH_RADIUS_KM * deltaLonRad * deltaSinLat;
}

/**
 * Sorteia um ponto (lon, lat) com distribuição estritamente uniforme em área na esfera terrestre
 */
function generateUniformRandomPoint(bbox) {
    // Longitude uniforme em graus
    const u1 = Math.random();
    const lon = bbox.minLon + u1 * (bbox.maxLon - bbox.minLon);

    // Latitude amostrada via sin(lat) para garantir área uniforme
    const sinLatMin = Math.sin(toRadians(bbox.minLat));
    const sinLatMax = Math.sin(toRadians(bbox.maxLat));
    const u2 = Math.random();
    
    const sinLat = sinLatMin + u2 * (sinLatMax - sinLatMin);
    const latRad = Math.asin(sinLat);
    const lat = latRad * 180 / Math.PI;

    return { lon, lat };
}

/**
 * Algoritmo de Ray Casting para verificação de ponto dentro de polígono com tratamento de degenerações
 * Retorna: 1 (Dentro), 0 (Fora), -1 (Degenerado / Inválido)
 */
function testPointInGeoJSON(point, geoJson) {
    const features = geoJson.type === 'FeatureCollection' ? geoJson.features : [geoJson];
    let totalIntersections = 0;

    for (const feature of features) {
        const geom = feature.geometry || feature;
        
        if (geom.type === 'Polygon') {
            const res = testPointInPolygonRings(point, geom.coordinates);
            if (res === -1) return -1; // Inválido devido à degeneração
            totalIntersections += res;
        } else if (geom.type === 'MultiPolygon') {
            for (const polygonCoords of geom.coordinates) {
                const res = testPointInPolygonRings(point, polygonCoords);
                if (res === -1) return -1; // Inválido devido à degeneração
                totalIntersections += res;
            }
        }
    }

    return (totalIntersections % 2 !== 0) ? 1 : 0;
}

/**
 * Verifica Ray Casting contra os anéis (exterior e furos) de um Polígono
 */
function testPointInPolygonRings(point, rings) {
    let polygonIntersections = 0;

    for (const ring of rings) {
        const numPoints = ring.length;
        
        for (let i = 0; i < numPoints - 1; i++) {
            const p1 = ring[i];
            const p2 = ring[i + 1];

            const x1 = p1[0], y1 = p1[1];
            const x2 = p2[0], y2 = p2[1];
            const px = point.lon, py = point.lat;

            // TRATAMENTO DE CASOS DEGENERADOS
            // 1. Ponto coincide diretamente com um vértice
            if (Math.abs(px - x1) < EPSILON && Math.abs(py - y1) < EPSILON) return -1;
            
            // 2. O raio horizontal (y = py) passa exatamente sobre um vértice
            if (Math.abs(py - y1) < EPSILON || Math.abs(py - y2) < EPSILON) return -1;

            // 3. Aresta horizontal e raio sobrepostos
            if (Math.abs(y1 - y2) < EPSILON && Math.abs(py - y1) < EPSILON) {
                if (px >= Math.min(x1, x2) - EPSILON && px <= Math.max(x1, x2) + EPSILON) {
                    return -1;
                }
            }

            // Teste padrão de intersecção do Ray Casting
            const intersectsLatitude = ((y1 > py) !== (y2 > py));
            if (intersectsLatitude) {
                const xIntersection = x1 + (py - y1) * (x2 - x1) / (y2 - y1);
                
                // Se a intersecção for muito próxima do ponto x, é um caso degenerado na aresta
                if (Math.abs(px - xIntersection) < EPSILON) return -1;

                if (xIntersection > px) {
                    polygonIntersections++;
                }
            }
        }
    }

    return polygonIntersections;
}

/**
 * Mapeia coordenadas geográficas (lon, lat) para coordenadas de pixel no Canvas
 */
function geoToCanvas(lon, lat, bbox, width, height, padding = 30) {
    const scaleX = (width - 2 * padding) / (bbox.maxLon - bbox.minLon);
    const scaleY = (height - 2 * padding) / (bbox.maxLat - bbox.minLat);
    
    // Manter a proporção preservada (aspect ratio)
    const scale = Math.min(scaleX, scaleY);

    const xCenterOffset = (width - (bbox.maxLon - bbox.minLon) * scale) / 2;
    const yCenterOffset = (height - (bbox.maxLat - bbox.minLat) * scale) / 2;

    const x = xCenterOffset + (lon - bbox.minLon) * scale;
    // O eixo Y do Canvas é invertido em relação à latitude
    const y = height - (yCenterOffset + (lat - bbox.minLat) * scale);

    return { x, y };
}

/**
 * Desenha o estado e a Bounding Box no Canvas
 */
function redrawScene(pointsInside = [], pointsOutside = []) {
    const width = mapCanvas.width / (window.devicePixelRatio || 1);
    const height = mapCanvas.height / (window.devicePixelRatio || 1);

    ctx.clearRect(0, 0, width, height);

    if (!currentGeoJson || !currentBoundingBox) return;

    const bbox = currentBoundingBox;
    const padding = 30;

    // 1. Desenhar Bounding Box
    const pMin = geoToCanvas(bbox.minLon, bbox.minLat, bbox, width, height, padding);
    const pMax = geoToCanvas(bbox.maxLon, bbox.maxLat, bbox, width, height, padding);

    ctx.strokeStyle = '#F59E0B';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.strokeRect(pMin.x, pMax.y, pMax.x - pMin.x, pMin.y - pMax.y);
    ctx.setLineDash([]);

    // 2. Desenhar Contornos do Estado
    ctx.fillStyle = 'rgba(99, 102, 241, 0.08)';
    ctx.strokeStyle = '#312E81';
    ctx.lineWidth = 2;

    const features = currentGeoJson.type === 'FeatureCollection' ? currentGeoJson.features : [currentGeoJson];

    features.forEach(feature => {
        const geom = feature.geometry || feature;
        
        function drawPolygon(rings) {
            ctx.beginPath();
            rings.forEach(ring => {
                ring.forEach((pt, idx) => {
                    const cp = geoToCanvas(pt[0], pt[1], bbox, width, height, padding);
                    if (idx === 0) ctx.moveTo(cp.x, cp.y);
                    else ctx.lineTo(cp.x, cp.y);
                });
            });
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        }

        if (geom.type === 'Polygon') {
            drawPolygon(geom.coordinates);
        } else if (geom.type === 'MultiPolygon') {
            geom.coordinates.forEach(poly => drawPolygon(poly));
        }
    });

    // 3. Desenhar Pontos Sorteados (Otimização para grandes quantidades)
    const pointRadius = pointsInside.length + pointsOutside.length > 2000 ? 1.5 : 2.5;

    // Pontos Dentro (Verde)
    ctx.fillStyle = '#DB3D7A';
    for (const pt of pointsInside) {
        const cp = geoToCanvas(pt.lon, pt.lat, bbox, width, height, padding);
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, pointRadius, 0, 2 * Math.PI);
        ctx.fill();
    }

    // Pontos Fora (Vermelho)
    ctx.fillStyle = '#7C5DA6';
    for (const pt of pointsOutside) {
        const cp = geoToCanvas(pt.lon, pt.lat, bbox, width, height, padding);
        ctx.beginPath();
        ctx.arc(cp.x, cp.y, pointRadius, 0, 2 * Math.PI);
        ctx.fill();
    }
}

/**
 * Inicia a simulação progressiva de Monte Carlo
 */
function startMonteCarloSimulation() {
    if (isCalculating) return;

    const targetValidPoints = parseInt(pointsSelect.value, 10);
    const uf = stateSelect.value;
    const realArea = officialAreas[uf] || 0;

    isCalculating = true;
    btnCalculate.disabled = true;
    stateSelect.disabled = true;
    pointsSelect.disabled = true;

    const bboxArea = calculateSphericalBboxArea(currentBoundingBox);

    let validCount = 0;
    let discardedCount = 0;
    const pointsInside = [];
    const pointsOutside = [];

    // Definição de tamanho de lote (batch) para manter animação suave
const batchSize = targetValidPoints >= 100000 
    ? 5000 
    : (targetValidPoints >= 10000 ? 500 : (targetValidPoints >= 1000 ? 50 : 10));

    function step() {
        let currentBatchValid = 0;

        while (currentBatchValid < batchSize && validCount < targetValidPoints) {
            const pt = generateUniformRandomPoint(currentBoundingBox);
            const status = testPointInGeoJSON(pt, currentGeoJson);

            if (status === -1) {
                discardedCount++; // Ponto descartado devido a caso degenerado
            } else if (status === 1) {
                pointsInside.push(pt);
                validCount++;
                currentBatchValid++;
            } else {
                pointsOutside.push(pt);
                validCount++;
                currentBatchValid++;
            }
        }

        // Atualizar interface gráfica
        const insideCount = pointsInside.length;
        const outsideCount = pointsOutside.length;
        const fraction = insideCount / validCount;
        const calculatedArea = fraction * bboxArea;
        const absError = Math.abs(calculatedArea - realArea);
        const relError = realArea > 0 ? (absError / realArea) * 100 : 0;

        updateMetricsUI({
            uf,
            targetValidPoints,
            discardedCount,
            insideCount,
            outsideCount,
            bboxArea,
            calculatedArea,
            realArea,
            absError,
            relError
        });

        redrawScene(pointsInside, pointsOutside);

        const progressPercent = Math.min(100, (validCount / targetValidPoints) * 100);
        progressBar.style.width = `${progressPercent}%`;
        progressText.textContent = `Amostrando: ${validCount.toLocaleString('pt-BR')} / ${targetValidPoints.toLocaleString('pt-BR')} pontos válidos (${progressPercent.toFixed(0)}%)`;

        if (validCount < targetValidPoints) {
            animationFrameId = requestAnimationFrame(step);
        } else {
            isCalculating = false;
            btnCalculate.disabled = false;
            stateSelect.disabled = false;
            pointsSelect.disabled = false;
            progressText.textContent = `Simulação concluída! ${discardedCount} pontos degenerados foram descartados.`;
        }
    }

    animationFrameId = requestAnimationFrame(step);
}

/**
 * Cancela qualquer cálculo em andamento
 */
function cancelCalculation() {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
    isCalculating = false;
    btnCalculate.disabled = false;
    stateSelect.disabled = false;
    pointsSelect.disabled = false;
}

/**
 * Reseta o painel e limpa a simulação
 */
function resetSimulation() {
    cancelCalculation();

    const uf = stateSelect.value;
    const realArea = officialAreas[uf] || 0;
    const bboxArea = currentBoundingBox ? calculateSphericalBboxArea(currentBoundingBox) : 0;

    progressBar.style.width = '0%';
    progressText.textContent = 'Aguardando início...';

    updateMetricsUI({
        uf,
        targetValidPoints: parseInt(pointsSelect.value, 10),
        discardedCount: 0,
        insideCount: 0,
        outsideCount: 0,
        bboxArea,
        calculatedArea: 0,
        realArea,
        absError: 0,
        relError: 0
    });

    redrawScene();
}

/**
 * Atualiza os valores na interface gráfica de métricas
 */
function updateMetricsUI(data) {
    metricState.textContent = data.uf;
    metricTargetPoints.textContent = data.targetValidPoints.toLocaleString('pt-BR');
    metricDiscardedPoints.textContent = data.discardedCount.toLocaleString('pt-BR');
    metricPointsInside.textContent = data.insideCount.toLocaleString('pt-BR');
    metricPointsOutside.textContent = data.outsideCount.toLocaleString('pt-BR');
    
    metricBboxArea.textContent = `${data.bboxArea.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} km²`;
    metricCalculatedArea.textContent = `${data.calculatedArea.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} km²`;
    metricRealArea.textContent = `${data.realArea.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} km²`;
    metricAbsError.textContent = `${data.absError.toLocaleString('pt-BR', { maximumFractionDigits: 2 })} km²`;
    metricRelError.textContent = `${data.relError.toFixed(2)} %`;
}
