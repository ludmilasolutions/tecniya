// netlify/functions/api.js
const fetch = require('node-fetch');
const admin = require('firebase-admin');

// INICIALIZAR FIREBASE ADMIN
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    }),
    databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
  });
}

const db = admin.firestore();

// HEADERS CORS
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
};

// HANDLER PRINCIPAL
exports.handler = async (event) => {
  // MANEJAR CORS PREFLIGHT
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: ''
    };
  }

  const path = event.path.replace('/.netlify/functions/api', '');
  
  try {
    // RUTAS
    if (path === '/register' && event.httpMethod === 'POST') {
      return await handleRegister(event);
    }
    
    if (path === '/professionals' && event.httpMethod === 'GET') {
      return await handleGetProfessionals(event);
    }
    
    if (path === '/updateProfessional' && event.httpMethod === 'POST') {
      return await handleUpdateProfessional(event);
    }
    
    if (path === '/createQuote' && event.httpMethod === 'POST') {
      return await handleCreateQuote(event);
    }
    
    if (path === '/banners' && event.httpMethod === 'GET') {
      return await handleGetBanners(event);
    }
    
    if (path === '/trackClick' && event.httpMethod === 'POST') {
      return await handleTrackClick(event);
    }
    
    if (path === '/admin/stats' && event.httpMethod === 'GET') {
      return await handleAdminStats(event);
    }
    
    return {
      statusCode: 404,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Ruta no encontrada' })
    };
    
  } catch (error) {
    console.error('Error en API:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message })
    };
  }
};

// 1. REGISTRO DE PROFESIONAL
async function handleRegister(event) {
  const data = JSON.parse(event.body);
  const { email, password, name, phone } = data;
  
  // VALIDACIONES
  if (!email || !password || !name || !phone) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Faltan campos requeridos' })
    };
  }
  
  try {
    // CREAR USUARIO EN FIREBASE AUTH
    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: name
    });
    
    // CREAR DOCUMENTO EN PROFESSIONALS
    await db.collection('professionals').doc(userRecord.uid).set({
      userId: userRecord.uid,
      email,
      name,
      phone,
      photoUrl: '',
      rubros: [],
      zonas: [],
      rating: 0,
      reviewsCount: 0,
      jobsCompleted: 0,
      lastActive: null,
      profileCompleted: false,
      isFeatured: false,
      featuredUntil: null,
      rankingScore: 0,
      blocked: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ 
        success: true, 
        userId: userRecord.uid,
        message: 'Profesional registrado exitosamente' 
      })
    };
    
  } catch (error) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message })
    };
  }
}

// 2. OBTENER PROFESIONALES (PARA BÚSQUEDA)
async function handleGetProfessionals(event) {
  const { rubro, zona, limit = 50 } = event.queryStringParameters || {};
  
  // VALIDAR QUE RUBRO Y ZONA EXISTAN
  if (!rubro || !zona) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Se requieren rubro y zona' })
    };
  }
  
  try {
    // CONSTRUIR CONSULTA BASE
    let query = db.collection('professionals')
      .where('profileCompleted', '==', true)
      .where('blocked', '==', false)
      .where('photoUrl', '!=', '')
      .where('rubros', 'array-contains', rubro);
    
    if (zona !== 'toda') {
      query = query.where('zonas', 'array-contains', zona);
    }
    
    const snapshot = await query.get();
    
    // PROCESAR Y ORDENAR
    const professionals = [];
    const now = new Date();
    
    snapshot.forEach(doc => {
      const prof = { id: doc.id, ...doc.data() };
      
      // CALCULAR RANKING SCORE (MISMO ALGORITMO QUE FRONTEND)
      let rankingScore = 0;
      rankingScore += (prof.rating || 0) * 5;
      rankingScore += (prof.jobsCompleted || 0) * 2;
      
      if (prof.lastActive) {
        const lastActiveDate = prof.lastActive.toDate();
        const daysDiff = Math.floor((now - lastActiveDate) / (1000 * 60 * 60 * 24));
        if (daysDiff <= 7) rankingScore += 3;
        else if (daysDiff <= 15) rankingScore += 2;
      }
      
      if (prof.profileCompleted) rankingScore += 5;
      
      // DESTACADO ACTIVO (PRIORIDAD MÁXIMA)
      if (prof.isFeatured && prof.featuredUntil && prof.featuredUntil.toDate() > now) {
        rankingScore += 1000;
        prof.isFeaturedActive = true;
      }
      
      prof.rankingScore = rankingScore;
      professionals.push(prof);
    });
    
    // ORDENAR
    professionals.sort((a, b) => {
      if (a.isFeaturedActive && !b.isFeaturedActive) return -1;
      if (!a.isFeaturedActive && b.isFeaturedActive) return 1;
      return b.rankingScore - a.rankingScore;
    });
    
    // LIMITAR RESULTADOS
    const limitedResults = professionals.slice(0, parseInt(limit));
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ professionals: limitedResults })
    };
    
  } catch (error) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message })
    };
  }
}

// 3. ACTUALIZAR PROFESIONAL
async function handleUpdateProfessional(event) {
  const data = JSON.parse(event.body);
  const { professionalId, updates, authToken } = data;
  
  // VERIFICAR AUTENTICACIÓN
  if (!authToken) {
    return {
      statusCode: 401,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'No autenticado' })
    };
  }
  
  try {
    // VERIFICAR TOKEN
    const decodedToken = await admin.auth().verifyIdToken(authToken);
    
    // VERIFICAR QUE EL USUARIO SEA EL DUEÑO DEL PERFIL
    const professionalDoc = await db.collection('professionals').doc(professionalId).get();
    if (!professionalDoc.exists) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Profesional no encontrado' })
      };
    }
    
    const professionalData = professionalDoc.data();
    if (professionalData.userId !== decodedToken.uid) {
      return {
        statusCode: 403,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'No autorizado' })
      };
    }
    
    // ACTUALIZAR
    await db.collection('professionals').doc(professionalId).update({
      ...updates,
      lastActive: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // VERIFICAR SI EL PERFIL ESTÁ COMPLETO
    const updatedDoc = await db.collection('professionals').doc(professionalId).get();
    const updatedData = updatedDoc.data();
    
    const isComplete = updatedData.name && updatedData.phone && updatedData.photoUrl && 
                       updatedData.rubros && updatedData.rubros.length > 0 &&
                       updatedData.zonas && updatedData.zonas.length > 0;
    
    await db.collection('professionals').doc(professionalId).update({
      profileCompleted: isComplete
    });
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ 
        success: true, 
        profileCompleted: isComplete,
        message: 'Perfil actualizado exitosamente' 
      })
    };
    
  } catch (error) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message })
    };
  }
}

// 4. CREAR PRESUPUESTO
async function handleCreateQuote(event) {
  const data = JSON.parse(event.body);
  const { professionalId, clientName, clientPhone, items, total, authToken } = data;
  
  // VALIDACIONES
  if (!professionalId || !clientName || !clientPhone || !items || !total) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Faltan campos requeridos' })
    };
  }
  
  // VERIFICAR AUTENTICACIÓN
  if (!authToken) {
    return {
      statusCode: 401,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'No autenticado' })
    };
  }
  
  try {
    // VERIFICAR TOKEN Y QUE SEA DESTACADO ACTIVO
    const decodedToken = await admin.auth().verifyIdToken(authToken);
    
    const professionalDoc = await db.collection('professionals').doc(professionalId).get();
    if (!professionalDoc.exists) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Profesional no encontrado' })
      };
    }
    
    const professionalData = professionalDoc.data();
    
    // VERIFICAR PROPIEDAD
    if (professionalData.userId !== decodedToken.uid) {
      return {
        statusCode: 403,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'No autorizado' })
      };
    }
    
    // VERIFICAR QUE SEA DESTACADO ACTIVO
    const now = new Date();
    const isFeaturedActive = professionalData.isFeatured && 
                            professionalData.featuredUntil && 
                            professionalData.featuredUntil.toDate() > now;
    
    if (!isFeaturedActive) {
      return {
        statusCode: 403,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Solo profesionales destacados pueden crear presupuestos' })
      };
    }
    
    // CREAR PRESUPUESTO
    const quoteRef = await db.collection('quotes').add({
      professionalId,
      clientName,
      clientPhone,
      items: Array.isArray(items) ? items : items.split('\n').filter(item => item.trim()),
      total: parseFloat(total),
      status: 'creado',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ 
        success: true, 
        quoteId: quoteRef.id,
        message: 'Presupuesto creado exitosamente' 
      })
    };
    
  } catch (error) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message })
    };
  }
}

// 5. OBTENER BANNERS ACTIVOS
async function handleGetBanners(event) {
  const { rubro, city, position } = event.queryStringParameters || {};
  
  try {
    const now = new Date();
    let query = db.collection('banners')
      .where('active', '==', true)
      .where('startDate', '<=', now)
      .where('endDate', '>=', now);
    
    if (city) {
      query = query.where('city', '==', city);
    }
    
    if (position) {
      query = query.where('position', '==', position);
    }
    
    const snapshot = await query.get();
    const banners = [];
    
    snapshot.forEach(doc => {
      const banner = doc.data();
      
      // FILTRAR POR RUBRO SI SE ESPECIFICA
      if (rubro && banner.rubros && !banner.rubros.includes('todos') && !banner.rubros.includes(rubro)) {
        return;
      }
      
      banners.push({
        id: doc.id,
        ...banner,
        startDate: banner.startDate ? banner.startDate.toDate().toISOString() : null,
        endDate: banner.endDate ? banner.endDate.toDate().toISOString() : null
      });
    });
    
    // ORDENAR ALEATORIAMENTE Y TOMAR 1
    const randomBanner = banners.length > 0 ? 
      banners[Math.floor(Math.random() * banners.length)] : null;
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ banner: randomBanner })
    };
    
  } catch (error) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message })
    };
  }
}

// 6. REGISTRAR CLICK EN BANNER
async function handleTrackClick(event) {
  const data = JSON.parse(event.body);
  const { bannerId, city } = data;
  
  if (!bannerId) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Falta bannerId' })
    };
  }
  
  try {
    // VERIFICAR QUE EL BANNER EXISTA
    const bannerDoc = await db.collection('banners').doc(bannerId).get();
    if (!bannerDoc.exists) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Banner no encontrado' })
      };
    }
    
    // REGISTRAR CLICK
    await db.collection('ads_clicks').add({
      bannerId,
      city: city || 'Rosario',
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ success: true })
    };
    
  } catch (error) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message })
    };
  }
}

// 7. ESTADÍSTICAS ADMIN
async function handleAdminStats(event) {
  const { authToken } = event.queryStringParameters || {};
  
  // VERIFICAR AUTENTICACIÓN ADMIN
  if (!authToken) {
    return {
      statusCode: 401,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'No autenticado' })
    };
  }
  
  try {
    const decodedToken = await admin.auth().verifyIdToken(authToken);
    
    // VERIFICAR QUE SEA ADMIN
    const adminDoc = await db.collection('admin_users').doc(decodedToken.uid).get();
    if (!adminDoc.exists) {
      return {
        statusCode: 403,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'No autorizado' })
      };
    }
    
    // OBTENER ESTADÍSTICAS
    const now = new Date();
    
    // CONTAR PROFESIONALES
    const professionalsSnapshot = await db.collection('professionals').get();
    const totalProfessionals = professionalsSnapshot.size;
    
    // CONTAR DESTACADOS ACTIVOS
    let featuredActive = 0;
    professionalsSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.isFeatured && data.featuredUntil && data.featuredUntil.toDate() > now) {
        featuredActive++;
      }
    });
    
    // CONTAR PRESUPUESTOS
    const quotesSnapshot = await db.collection('quotes').get();
    const totalQuotes = quotesSnapshot.size;
    
    // CONTAR CLICKS
    const clicksSnapshot = await db.collection('ads_clicks').get();
    const totalClicks = clicksSnapshot.size;
    
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        totalProfessionals,
        featuredActive,
        totalQuotes,
        totalClicks
      })
    };
    
  } catch (error) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message })
    };
  }
}