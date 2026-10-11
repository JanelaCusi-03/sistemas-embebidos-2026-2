import 'package:flutter/material.dart';

/// Paleta kawaii (pasteles)
class K {
  static const rosa = Color(0xFFFF8FB1), rosaL = Color(0xFFFFE3EC);
  static const menta = Color(0xFF6FD6B5), mentaL = Color(0xFFDFF8EF);
  static const lila = Color(0xFFB59CFF), lilaL = Color(0xFFEEE8FF);
  static const crema = Color(0xFFFFF8F3), tinta = Color(0xFF3B3355), suave = Color(0xFF8A82A3);
}

ThemeData kTheme() => ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(seedColor: K.lila),
      scaffoldBackgroundColor: K.crema,
    );

/// Tarjeta blanca redondeada con sombra suave
class KCard extends StatelessWidget {
  final Widget child;
  final EdgeInsets padding;
  const KCard({super.key, required this.child, this.padding = const EdgeInsets.all(16)});
  @override
  Widget build(BuildContext context) => Container(
        padding: padding,
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(28),
          boxShadow: const [BoxShadow(color: Color(0x228A6FD0), blurRadius: 20, offset: Offset(0, 8))],
        ),
        child: child,
      );
}

/// Casilla de dato: emoji + valor + etiqueta
class Stat extends StatelessWidget {
  final String emoji, valor, etiqueta;
  final Color color;
  const Stat(this.emoji, this.valor, this.etiqueta, this.color, {super.key});
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(vertical: 10),
        decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(20)),
        child: Column(children: [
          Text(emoji, style: const TextStyle(fontSize: 20)),
          Text(valor, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18, color: K.tinta)),
          Text(etiqueta, style: const TextStyle(fontSize: 11, color: K.suave)),
        ]),
      );
}

/// Botón circular flotante sobre el mapa
Widget botonRedondo(IconData icono, VoidCallback onTap) => Material(
      color: Colors.white,
      elevation: 4,
      shadowColor: const Color(0x558A6FD0),
      shape: const CircleBorder(),
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: Padding(padding: const EdgeInsets.all(12), child: Icon(icono, color: K.tinta)),
      ),
    );

/// Botón "píldora" para elegir fecha / hora
Widget pill(String texto, VoidCallback onTap, {Color color = K.lilaL}) => Material(
      color: color,
      shape: const StadiumBorder(),
      child: InkWell(
        customBorder: const StadiumBorder(),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          child: Text(texto, style: const TextStyle(fontWeight: FontWeight.w700, color: K.tinta)),
        ),
      ),
    );
