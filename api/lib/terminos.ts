// Términos y condiciones de Fitvang. Fuente única: se muestran en el modal
// (vía /users/terminos) y se incrustan en el documento que se guarda en Cloudinary.

export const TERMINOS_VERSION = '1.0';

export const TERMINOS_SECCIONES: { titulo: string; texto: string }[] = [
  { titulo: '1. Aceptación', texto: 'Al usar la app y las instalaciones de Fitvang (club de entrenamiento funcional y fútbol funcional, Cali, Colombia) aceptas estos Términos y Condiciones. Si no estás de acuerdo, no debes usar el servicio.' },
  { titulo: '2. Estado físico y riesgo', texto: 'Declaras estar en condiciones de salud aptas para realizar actividad física. La práctica de ejercicio conlleva riesgos; asumes la responsabilidad por tu participación y te comprometes a informar al staff cualquier condición médica relevante.' },
  { titulo: '3. Reservas, cancelaciones y asistencia', texto: 'Las reservas se hacen con al menos 30 minutos de anticipación y se pueden modificar o cancelar hasta 1 hora antes. Cada clase tiene cupos limitados; si está llena entras a lista de espera. Faltar a una clase reservada no exime del consumo de la sesión del plan.' },
  { titulo: '4. Pagos y planes', texto: 'Solo con un plan activo puedes reservar, y el plan debe cubrir el tipo de clase. Los valores y la vigencia de cada plan se informan al momento de la asignación. Los pagos pendientes deben ponerse al día para mantener el acceso.' },
  { titulo: '5. Conducta e instalaciones', texto: 'Te comprometes a cuidar los equipos e instalaciones, a seguir las indicaciones del staff y a mantener un trato respetuoso con coaches y demás miembros.' },
  { titulo: '6. Tratamiento de datos personales', texto: 'Autorizas a Fitvang a recolectar y tratar tus datos personales (nombre, documento, contacto y datos de uso) para la gestión de tu membresía, conforme a la Ley 1581 de 2012 de Colombia. Puedes ejercer tus derechos de acceso, corrección y supresión contactando al club.' },
  { titulo: '7. Uso de imagen', texto: 'Fitvang puede capturar fotos o video durante las clases con fines de registro y difusión del club. Si no deseas aparecer, debes informarlo por escrito al staff.' },
  { titulo: '8. Vigencia y cambios', texto: 'Estos términos pueden actualizarse. El uso continuado del servicio implica la aceptación de la versión vigente.' },
];

export function terminosHtml(p: { nombre: string; documento: string; fecha: string }): string {
  const secciones = TERMINOS_SECCIONES.map(
    (s) => `<section><h2>${s.titulo}</h2><p>${s.texto}</p></section>`,
  ).join('\n');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8" />
<title>Términos y Condiciones — Fitvang</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;max-width:760px;margin:40px auto;padding:0 24px;color:#111;line-height:1.55}
  h1{font-size:22px;margin-bottom:4px}
  .meta{color:#555;font-size:13px;margin-bottom:24px;border-bottom:1px solid #ddd;padding-bottom:16px}
  h2{font-size:15px;margin:18px 0 4px}
  p{font-size:14px;margin:0}
  .firma{margin-top:32px;border-top:1px solid #ddd;padding-top:16px;font-size:13px;color:#333}
</style></head><body>
<h1>Términos y Condiciones — Fitvang</h1>
<div class="meta">Versión ${TERMINOS_VERSION}</div>
<div class="meta">
  <strong>Aceptado por:</strong> ${p.nombre}<br/>
  <strong>Documento:</strong> ${p.documento}<br/>
  <strong>Fecha de aceptación:</strong> ${p.fecha}
</div>
${secciones}
<div class="firma">
  Este documento certifica que <strong>${p.nombre}</strong> (documento ${p.documento}) aceptó
  los Términos y Condiciones de Fitvang el ${p.fecha} a través de la aplicación.
</div>
</body></html>`;
}
